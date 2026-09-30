"""FastAPI app: live WebSocket, sessions and stats over HTTP, belt control, and the web app.

Read-only for everyone who can reach it (the Cloudflare Tunnel adds Cloudflare Access in front):
  GET /status, GET /sessions, GET /sessions/{id}, GET /stats, WebSocket /live
Control, localhost/LAN only (see access.py), with an `X-Client-Id` header naming a client that has
/live open (so the belt stops if that client goes away):
  POST /control/start {"kmh": 1.5}, POST /control/speed {"kmh": 2.0}, POST /control/stop
The custom header also makes browsers send a CORS preflight, which only this origin passes, so a
page from another site cannot drive the belt through a LAN browser.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import math
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from starlette.types import Receive, Scope, Send
from pydantic import BaseModel, Field
from starlette.websockets import WebSocketDisconnect

from .access import control_refusal, is_local_client
from .backend import BackendError
from .config import Config
from .service import BridgeService, ControlError, sample_message
from .stats import compute_stats

log = logging.getLogger(__name__)

CLIENT_ID_PATTERN = r"^[A-Za-z0-9_.-]{1,64}$"

NO_WEB_APP = """<!doctype html><meta charset="utf-8"><title>WalkPad bridge</title>
<p>The WalkPad bridge is running, but the web app is not built.
Run <code>npm run build</code> in <code>web/</code>, then reload.
API: <a href="/status">/status</a>, <a href="/stats">/stats</a>, <a href="/sessions">/sessions</a>.</p>
"""


class SpeedRequest(BaseModel):
    kmh: float = Field(gt=0, allow_inf_nan=False)


def create_app(service: BridgeService, config: Config) -> FastAPI:
    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        await service.start()
        try:
            yield
        finally:
            await service.close()

    app = FastAPI(title="WalkPad bridge", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(config.server.cors_origins),
        allow_methods=["GET"],  # cross-origin pages may read, never control
    )

    def control_client(
        request: Request,
        x_client_id: Annotated[str, Header(pattern=CLIENT_ID_PATTERN)],
    ) -> str:
        reason = control_refusal(
            request.client.host if request.client else None,
            request.headers,
            allow_remote=config.server.allow_remote_control,
            extra_hosts=config.server.control_hosts,
        )
        if reason is not None:
            log.warning("refused control from %s: %s", request.client, reason)
            raise HTTPException(403, reason)
        return x_client_id

    # A plain default (not an Annotated alias): this module uses postponed annotations, and
    # FastAPI cannot resolve an alias that is local to this function.
    client_dep = Depends(control_client)

    async def run_control(coro: Any) -> dict[str, Any]:
        try:
            result = await coro
        except ControlError as exc:
            raise HTTPException(409, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except BackendError as exc:
            raise HTTPException(503, str(exc)) from exc
        status = service.status()
        if isinstance(result, float):
            status["applied_target_kmh"] = result  # after the cap, not the request echoed
        return status

    # --- read-only ---------------------------------------------------------------------------
    # All endpoints are async: the SQLite connection lives on the event loop's thread, and a
    # plain `def` endpoint would run in FastAPI's thread pool.

    @app.get("/status")
    async def status(request: Request) -> dict[str, Any]:
        s = service.status()
        s["control_allowed"] = control_refusal(
            request.client.host if request.client else None,
            request.headers,
            allow_remote=config.server.allow_remote_control,
            extra_hosts=config.server.control_hosts,
        ) is None
        return s

    @app.get("/sessions")
    async def sessions(
        limit: Annotated[int, Query(ge=1, le=500)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
    ) -> dict[str, Any]:
        return {
            "total": service.store.count_sessions(),
            "sessions": service.store.list_sessions(limit, offset),
        }

    @app.get("/sessions/{session_id}")
    async def session(session_id: int) -> dict[str, Any]:
        found = service.store.get_session(session_id)
        if found is None:
            raise HTTPException(404, "no such session")
        return found

    @app.get("/stats")
    async def stats() -> dict[str, Any]:
        return compute_stats(service.store.finished_sessions(), now=service.wall_clock())

    @app.websocket("/live")
    async def live(
        websocket: WebSocket,
        client: Annotated[str | None, Query(pattern=CLIENT_ID_PATTERN)] = None,
    ) -> None:
        await websocket.accept()
        host = websocket.client.host if websocket.client else None
        # Only a local client's socket counts for control (and keeps its grace period alive).
        tracked = client if client and is_local_client(host, websocket.headers) else None
        queue = service.subscribe()
        if tracked:
            service.client_connected(tracked)
        try:
            await websocket.send_json(service.status())
            if service.last_sample is not None and service.backend.is_connected:
                await websocket.send_json(
                    sample_message(service.last_sample, service.wall_clock(),
                                   service.recorder.session_id)
                )
            sender = asyncio.create_task(_forward(queue, websocket))
            receiver = asyncio.create_task(_drain(websocket))
            try:
                await asyncio.wait({sender, receiver}, return_when=asyncio.FIRST_COMPLETED)
            finally:
                sender.cancel()
                receiver.cancel()
        except WebSocketDisconnect:
            pass
        finally:
            service.unsubscribe(queue)
            if tracked:
                service.client_disconnected(tracked)

    # --- control (localhost/LAN) -------------------------------------------------------------

    @app.post("/control/start")
    async def control_start(body: SpeedRequest, client: str = client_dep) -> dict[str, Any]:
        return await run_control(service.control_start(client, body.kmh))

    @app.post("/control/speed")
    async def control_speed(body: SpeedRequest, client: str = client_dep) -> dict[str, Any]:
        return await run_control(service.control_speed(client, body.kmh))

    @app.post("/control/stop")
    async def control_stop(client: str = client_dep) -> dict[str, Any]:
        return await run_control(service.control_stop(client))

    # --- the web app ---------------------------------------------------------------------------

    web_dist = config.server.web_dist_path()
    if not (web_dist / "index.html").is_file():
        log.warning("web app not built (%s missing); serving a placeholder at / until it is", web_dist)
    app.mount("/", WebApp(web_dist), name="web")

    return app


class WebApp:
    """Serves the built web app, deciding per request: a build made after the bridge started
    (or deleted since) is picked up without a restart. Placeholder page while there is none."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self._static: StaticFiles | None = None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not (self.directory / "index.html").is_file():
            self._static = None
            await HTMLResponse(NO_WEB_APP)(scope, receive, send)
            return
        if self._static is None:
            self._static = StaticFiles(directory=self.directory, html=True)
        await self._static(scope, receive, send)


async def _forward(queue: asyncio.Queue[dict[str, Any]], websocket: WebSocket) -> None:
    while True:
        message = await queue.get()
        await websocket.send_json(_finite(message))


async def _drain(websocket: WebSocket) -> None:
    """Read (and ignore) client messages; returns when the client disconnects."""
    with contextlib.suppress(WebSocketDisconnect):
        while True:
            await websocket.receive_text()


def _finite(message: dict[str, Any]) -> dict[str, Any]:
    return {k: (None if isinstance(v, float) and not math.isfinite(v) else v)
            for k, v in message.items()}
