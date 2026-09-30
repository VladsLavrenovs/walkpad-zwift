"""Live samples as JSON UDP datagrams (one per sample) for the future Windows game receiver.

Fire and forget: a receiver that is off or unreachable never slows down or breaks the bridge.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

log = logging.getLogger(__name__)


class _Protocol(asyncio.DatagramProtocol):
    def error_received(self, exc: Exception) -> None:
        log.debug("UDP send error: %s", exc)  # e.g. ICMP port unreachable: receiver not running


class UdpSender:
    def __init__(self, host: str, port: int) -> None:
        self.host = host
        self.port = port
        self._transport: asyncio.DatagramTransport | None = None

    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        try:
            self._transport, _ = await loop.create_datagram_endpoint(
                _Protocol, remote_addr=(self.host, self.port)
            )
        except OSError as exc:
            log.error("UDP output to %s:%d disabled: %s", self.host, self.port, exc)
            return
        log.info("UDP output to %s:%d", self.host, self.port)

    def send(self, message: dict[str, Any]) -> None:
        if self._transport is None:
            return
        try:
            self._transport.sendto(json.dumps(message, separators=(",", ":")).encode())
        except OSError as exc:
            log.debug("UDP send failed: %s", exc)

    def close(self) -> None:
        if self._transport is not None:
            self._transport.close()
            self._transport = None
