"""FastAPI app: live WebSocket, sessions and stats over HTTP, belt control, and the web app.

Read-only for everyone who can reach it (the Cloudflare Tunnel adds Cloudflare Access in front):
  GET /status, GET /sessions, GET /sessions/{id}, GET /stats, WebSocket /live
Control, localhost/LAN only (see access.py), with an `X-Client-Id` header naming a client that has
/live open (so the belt stops if that client goes away):
  POST /control/start {"kmh": 1.5}, POST /control/speed {"kmh": 2.0}, POST /control/stop
Video library for the YouTube world: GET /videos for everyone; POST /videos, PATCH and DELETE
/videos/{id} localhost/LAN only with `X-Client-Id` (remote access is read-only), no /live needed.
Google 3D tiles cost guard: POST /tiles3d/session before the web app creates a 3D tiles
session (429 above the [google_3d] limits), GET /tiles3d/usage for the stats page. Open to any
page that can reach the bridge (OBS views use the 3D world too); every grant is counted.
Routes: GET /routes, /routes/{id} for everyone; importing (POST /routes/gpx), planning via
OpenRouteService (POST /routes/plan; the key stays on the bridge), saving, editing, choosing the
active route and deleting are localhost/LAN only, like the video library.
The custom header also makes browsers send a CORS preflight, which only this origin passes, so a
page from another site cannot drive the belt through a LAN browser.
"""

from __future__ import annotations

import asyncio
import json
import contextlib
import logging
import math
import secrets
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import Body, Depends, FastAPI, Header, HTTPException, Query, Request, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.types import Receive, Scope, Send
from pydantic import BaseModel, Field
from starlette.websockets import WebSocketDisconnect

from . import progression
from .access import control_refusal, is_local_client, origin_allowed
from .backend import BackendError
from .config import Config
from .service import BridgeService, ControlError, sample_message
from .stats import compute_stats
from .tiles3d import Tiles3dGuard
from .storage import DEFAULT_PACE_KMH
from .ors import OrsError, plan_walk
from .routes import clean_points, parse_gpx, route_length_m
from .youtube import parse_youtube_url

MAX_GPX_BYTES = 5_000_000
MAX_WORLD_BYTES = 32_000_000  # a saved world's snapshot (gzip); real ones are a few MB

log = logging.getLogger(__name__)

CLIENT_ID_PATTERN = r"^[A-Za-z0-9_.-]{1,64}$"

NO_WEB_APP = """<!doctype html><meta charset="utf-8"><title>WalkPad bridge</title>
<p>The WalkPad bridge is running, but the web app is not built.
Run <code>npm run build</code> in <code>web/</code>, then reload.
API: <a href="/status">/status</a>, <a href="/stats">/stats</a>, <a href="/sessions">/sessions</a>.</p>
"""


class SpeedRequest(BaseModel):
    kmh: float = Field(gt=0, allow_inf_nan=False)


class VideoCreate(BaseModel):
    url: str = Field(min_length=1, max_length=500)
    title: str = Field(default="", max_length=200)
    pace_kmh: float = Field(default=DEFAULT_PACE_KMH, ge=1, le=10, allow_inf_nan=False)


LatLon = Annotated[list[float], Field(min_length=2, max_length=2)]


class PlanRequest(BaseModel):
    waypoints: list[LatLon] = Field(min_length=2, max_length=10)


class RouteCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    source: str = Field(default="ors", pattern="^(ors|gpx)$")
    points: list[LatLon] = Field(min_length=2)


# The fantasy world's biomes a trail may start in (the web app's gen.ts; not the city).
StartBiome = Literal["forest", "ruins", "meadow", "fields", "village", "castle", "falls"]


class TrailCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    length_m: float = Field(ge=100, le=1_000_000, allow_inf_nan=False)
    seed: int | None = Field(default=None, ge=0, le=2**31 - 1)
    start_biome: StartBiome | None = None


class RouteUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    progress_m: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    seed: int | None = Field(default=None, ge=0, le=2**31 - 1)
    start_biome: StartBiome | None = None


class Discovery(BaseModel):
    kind: Literal["place", "province", "biome"]
    key: str = Field(min_length=1, max_length=40)


class Discoveries(BaseModel):
    items: list[Discovery] = Field(min_length=1, max_length=50)


class QuestCreate(BaseModel):
    id: str = Field(min_length=3, max_length=60, pattern=r"^[a-z0-9-]+:[0-9]{1,4}$")
    title: str = Field(min_length=1, max_length=120)
    kind: Literal["deliver", "visit", "explore"]
    data: dict[str, Any] = Field(default_factory=dict)
    xp: int = Field(ge=0, le=progression.QUEST_XP_MAX)


class QuestUpdate(BaseModel):
    progress: float | None = Field(default=None, ge=0, le=1e7, allow_inf_nan=False)
    state: Literal["done", "failed", "abandoned"] | None = None


class WorldRename(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class ActiveWorld(BaseModel):
    id: int | None


class WorldState(BaseModel):
    x: float = Field(ge=-1e6, le=1e6, allow_inf_nan=False)
    z: float = Field(ge=-1e6, le=1e6, allow_inf_nan=False)
    heading: float = Field(ge=-1e3, le=1e3, allow_inf_nan=False)
    walked_m: float = Field(ge=0, le=1e9, allow_inf_nan=False)


class ActiveRoute(BaseModel):
    id: int | None


class VideoUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    pace_kmh: float | None = Field(default=None, ge=1, le=10, allow_inf_nan=False)
    position_s: float | None = Field(default=None, ge=0, le=86400, allow_inf_nan=False)


def create_app(service: BridgeService, config: Config) -> FastAPI:
    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        await service.start()
        try:
            yield
        finally:
            await service.close()

    app = FastAPI(title="WalkPad bridge", lifespan=lifespan)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request: Request, exc: RequestValidationError) -> JSONResponse:
        # Not echoing the input: a NaN or Infinity there cannot be encoded as JSON (FastAPI's
        # default handler would turn a clean 422 into a 500).
        errors = [{k: e[k] for k in ("loc", "msg", "type") if k in e} for e in exc.errors()]
        return JSONResponse({"detail": errors}, status_code=422)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(config.server.app_origins),
        allow_methods=["GET"],  # cross-origin pages may read, never control
        allow_credentials=True,  # the Cloudflare Access cookie rides along
    )
    # Outermost: refuse other websites before anything else runs (HTTP and WebSocket).
    app.add_middleware(OriginGuard, app_origins=config.server.app_origins, extra_hosts=config.server.control_hosts)

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
                                   service.recorder.session_id, service.route)
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

    # --- video library (YouTube world) -----------------------------------------------------------

    @app.get("/videos")
    async def videos() -> dict[str, Any]:
        return {"videos": service.store.list_videos()}

    @app.post("/videos", status_code=201)
    async def add_video(body: VideoCreate, response: Response, _client: str = client_dep) -> dict[str, Any]:
        try:
            ref = parse_youtube_url(body.url)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        video, created = service.store.add_video(
            ref.video_id, body.url.strip(), body.title.strip(), body.pace_kmh, ref.start_s,
            service.wall_clock(),
        )
        if not created:
            response.status_code = 200  # already in the library
        return video

    @app.patch("/videos/{video_id}")
    async def update_video(video_id: int, body: VideoUpdate, _client: str = client_dep) -> dict[str, Any]:
        fields = body.model_dump(exclude_none=True)
        if "title" in fields:
            fields["title"] = fields["title"].strip()
        video = service.store.update_video(video_id, fields, service.wall_clock())
        if video is None:
            raise HTTPException(404, "no such video")
        return video

    @app.delete("/videos/{video_id}", status_code=204)
    async def delete_video(video_id: int, _client: str = client_dep) -> None:
        if not service.store.delete_video(video_id):
            raise HTTPException(404, "no such video")

    # --- Google 3D tiles cost guard ----------------------------------------------------------------

    guard = Tiles3dGuard(
        service.store,
        config.google_3d.max_sessions_per_day,
        config.google_3d.max_sessions_per_month,
        service.wall_clock,
    )

    @app.post("/tiles3d/session")
    async def tiles3d_session(
        x_client_id: Annotated[str | None, Header(pattern=CLIENT_ID_PATTERN)] = None,
    ) -> Response:
        grant = guard.request(x_client_id)
        if not grant.granted:
            log.warning("3D tiles session refused: %s (%s)", grant.message, grant.usage)
            return JSONResponse(
                {"detail": grant.message, "reason": grant.reason, "usage": grant.usage}, status_code=429
            )
        log.info("3D tiles session granted: %d today, %d this month", grant.usage["today"],
                 grant.usage["this_month"])
        return JSONResponse({"granted": True, "usage": grant.usage})

    @app.get("/tiles3d/usage")
    async def tiles3d_usage() -> dict[str, Any]:
        return guard.usage()

    # --- routes -----------------------------------------------------------------------------------

    @app.get("/routes")
    async def routes() -> dict[str, Any]:
        return {"routes": service.store.list_routes()}

    @app.get("/routes/{route_id}")
    async def route(route_id: int) -> dict[str, Any]:
        found = service.store.get_route(route_id)
        if found is None:
            raise HTTPException(404, "no such route")
        return found

    @app.post("/routes/gpx", status_code=201)
    async def import_gpx(
        request: Request,
        name: Annotated[str, Query(max_length=200)] = "",
        _client: str = client_dep,
    ) -> dict[str, Any]:
        body = await request.body()
        if len(body) > MAX_GPX_BYTES:
            raise HTTPException(413, f"GPX file larger than {MAX_GPX_BYTES // 1_000_000} MB")
        try:
            gpx = parse_gpx(body)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        route_name = name.strip() or gpx.name or "Imported route"
        return service.store.add_route(route_name, "gpx", gpx.points, route_length_m(gpx.points),
                                       service.wall_clock())

    @app.post("/routes/plan")
    async def plan_route(body: PlanRequest, _client: str = client_dep) -> dict[str, Any]:
        """A walking route through the waypoints, from OpenRouteService. Not saved."""
        try:
            planned = await plan_walk(clean_points((p[0], p[1]) for p in body.waypoints))
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except OrsError as exc:
            raise HTTPException(502, str(exc)) from exc
        return {"points": planned.points, "distance_m": planned.distance_m}

    @app.post("/routes", status_code=201)
    async def save_route(body: RouteCreate, _client: str = client_dep) -> dict[str, Any]:
        try:
            points = clean_points((p[0], p[1]) for p in body.points)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        return service.store.add_route(body.name.strip(), body.source, points, route_length_m(points),
                                       service.wall_clock())

    @app.post("/routes/trail", status_code=201)
    async def create_trail(body: TrailCreate, _client: str = client_dep) -> dict[str, Any]:
        """A fantasy-world trail: a name, a fixed length and a seed; no map."""
        seed = body.seed if body.seed is not None else secrets.randbelow(2**31)
        return service.store.add_route(body.name.strip(), "trail", [], body.length_m,
                                       service.wall_clock(), seed=seed, start_biome=body.start_biome)

    @app.patch("/routes/{route_id}")
    async def update_route(route_id: int, body: RouteUpdate, _client: str = client_dep) -> dict[str, Any]:
        updated = service.store.update_route(
            route_id, body.name.strip() if body.name else None, body.progress_m, body.seed, body.start_biome
        )
        if updated is None:
            raise HTTPException(404, "no such route")
        service.route_changed()
        return updated

    @app.put("/routes/active")
    async def set_active_route(
        body: Annotated[ActiveRoute, Body()], _client: str = client_dep
    ) -> dict[str, Any]:
        if not service.store.set_active_route(body.id):
            raise HTTPException(404, "no such route")
        service.route_changed()
        return {"route": service.route}

    # --- open world: saved worlds (anyone may read; changes are local-only) --------------------

    @app.get("/worlds")
    async def worlds() -> dict[str, Any]:
        return {"worlds": service.store.list_worlds()}

    @app.get("/worlds/{world_id}/snapshot")
    async def world_snapshot(world_id: int) -> Response:
        data = service.store.world_snapshot(world_id)
        if data is None:
            raise HTTPException(404, "no such world")
        # Ids can be reused after a delete: the client asks every time (no caching by URL).
        return Response(data, media_type="application/octet-stream", headers={"Cache-Control": "no-cache"})

    @app.post("/worlds", status_code=201)
    async def save_world(
        request: Request,
        name: Annotated[str, Query(min_length=1, max_length=80)],
        seed: Annotated[int, Query(ge=0, le=2**31 - 1)],
        gen_version: Annotated[int, Query(ge=1, le=10_000)],
        _client: str = client_dep,
    ) -> dict[str, Any]:
        """Save a generated world: the body is its snapshot (gzip) as the web app made it."""
        body = await request.body()
        if len(body) > MAX_WORLD_BYTES:
            raise HTTPException(413, f"world snapshot larger than {MAX_WORLD_BYTES // 1_000_000} MB")
        if body[:2] != b"\x1f\x8b":
            raise HTTPException(422, "a world snapshot is gzip data")
        return service.store.add_world(name.strip(), seed, gen_version, body, service.wall_clock())

    @app.patch("/worlds/{world_id}")
    async def rename_world(world_id: int, body: WorldRename, _client: str = client_dep) -> dict[str, Any]:
        world = service.store.rename_world(world_id, body.name.strip())
        if world is None:
            raise HTTPException(404, "no such world")
        return world

    @app.put("/worlds/active")
    async def set_active_world(body: Annotated[ActiveWorld, Body()], _client: str = client_dep) -> dict[str, Any]:
        if not service.store.set_active_world(body.id):
            raise HTTPException(404, "no such world")
        return {"worlds": service.store.list_worlds()}

    @app.put("/worlds/{world_id}/state")
    async def set_world_state(world_id: int, body: WorldState, _client: str = client_dep) -> dict[str, Any]:
        world = service.store.set_world_state(world_id, body.x, body.z, body.heading, body.walked_m, service.wall_clock())
        if world is None:
            raise HTTPException(404, "no such world")
        return world

    # --- open world: progression (anyone may read; discoveries are local-only) ------------------

    @app.get("/game/profile")
    async def game_profile() -> dict[str, Any]:
        return service.game_profile()

    @app.get("/worlds/{world_id}/discoveries")
    async def world_discoveries(world_id: int) -> dict[str, Any]:
        return {"discoveries": service.store.discoveries(world_id)}

    @app.post("/worlds/{world_id}/discoveries")
    async def add_discoveries(world_id: int, body: Discoveries, _client: str = client_dep) -> dict[str, Any]:
        """Places, provinces and biomes reached for the first time in a world: XP for each new one."""
        if service.store.get_world(world_id) is None:
            raise HTTPException(404, "no such world")
        items = []
        for d in body.items:
            xp = progression.discovery_xp(d.kind, d.key)
            if xp is None:
                raise HTTPException(422, f"not a discovery: {d.kind} {d.key}")
            items.append((d.kind, d.key, xp))
        new = service.store.add_discoveries(world_id, items, service.wall_clock())
        return {"new": new, "profile": service.game_profile()}

    @app.get("/worlds/{world_id}/quests")
    async def world_quests(world_id: int) -> dict[str, Any]:
        return {"quests": service.store.quests(world_id)}

    @app.post("/worlds/{world_id}/quests", status_code=201)
    async def take_quest(world_id: int, body: QuestCreate, _client: str = client_dep) -> dict[str, Any]:
        """Take a quest an NPC offered (each quest once; a few at a time)."""
        if service.store.get_world(world_id) is None:
            raise HTTPException(404, "no such world")
        if len(json.dumps(body.data)) > 2000:
            raise HTTPException(422, "quest data too large")
        active = [q for q in service.store.quests(world_id) if q["state"] == "active"]
        if len(active) >= progression.MAX_ACTIVE_QUESTS:
            raise HTTPException(409, f"at most {progression.MAX_ACTIVE_QUESTS} quests at a time")
        quest = service.store.add_quest(world_id, body.id, body.title.strip(), body.kind, body.data, body.xp,
                                        service.wall_clock())
        if quest is None:
            raise HTTPException(409, "this quest was taken before")
        return quest

    @app.patch("/worlds/{world_id}/quests/{quest_id}")
    async def update_quest(world_id: int, quest_id: str, body: QuestUpdate, _client: str = client_dep) -> dict[str, Any]:
        """Progress on a quest, or its end (done pays its XP)."""
        quest = service.store.update_quest(world_id, quest_id, body.progress, body.state, service.wall_clock())
        if quest is None:
            raise HTTPException(404, "no such quest")
        return {"quest": quest, "profile": service.game_profile()}

    @app.delete("/worlds/{world_id}", status_code=204)
    async def delete_world(world_id: int, _client: str = client_dep) -> None:
        if not service.store.delete_world(world_id):
            raise HTTPException(404, "no such world")

    @app.delete("/routes/{route_id}", status_code=204)
    async def delete_route(route_id: int, _client: str = client_dep) -> None:
        if not service.store.delete_route(route_id):
            raise HTTPException(404, "no such route")
        service.route_changed()

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


class OriginGuard:
    """ASGI middleware: a request or WebSocket whose `Origin` is not allowed gets 403."""

    def __init__(self, app: Any, app_origins: tuple[str, ...], extra_hosts: tuple[str, ...]) -> None:
        self.app = app
        self.app_origins = app_origins
        self.extra_hosts = extra_hosts

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] in ("http", "websocket"):
            origin = next((v.decode("latin-1") for k, v in scope["headers"] if k == b"origin"), None)
            if not origin_allowed(origin, self.app_origins, self.extra_hosts):
                log.warning("refused %s %s from origin %s", scope["type"], scope.get("path"), origin)
                if scope["type"] == "websocket":
                    await receive()  # websocket.connect
                    await send({"type": "websocket.close", "code": 1008})  # before accept: HTTP 403
                    return
                body = b'{"detail":"origin not allowed"}'
                await send({"type": "http.response.start", "status": 403,
                            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)
