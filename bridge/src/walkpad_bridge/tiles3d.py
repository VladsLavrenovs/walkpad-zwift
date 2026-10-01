"""Cost guard for Google Photorealistic 3D Tiles.

Every Google 3D tiles session (the web app's root tileset request) costs money. Before creating
one, the web app asks the bridge, which counts granted sessions per day and per month (the
bridge laptop's local time) and refuses above the limits in [google_3d]. Counting and the limit
check happen in one transaction, so two pages asking at once cannot both slip past the limit.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, tzinfo
from typing import Any

from .storage import Store


def period_keys(t: float, tz: tzinfo | None = None) -> tuple[str, str]:
    """('YYYY-MM-DD', 'YYYY-MM') of unix time `t`, local time unless `tz` is given."""
    d = datetime.fromtimestamp(t, tz)
    return d.strftime("%Y-%m-%d"), d.strftime("%Y-%m")


@dataclass(frozen=True, slots=True)
class Grant:
    granted: bool
    reason: str | None  # "day" | "month" when refused
    usage: dict[str, Any]

    @property
    def message(self) -> str:
        if self.granted:
            return "granted"
        when = "tomorrow" if self.reason == "day" else "next month"
        return f"3D world limit reached — resets {when}"


class Tiles3dGuard:
    def __init__(
        self,
        store: Store,
        per_day: int,
        per_month: int,
        wall_clock: Callable[[], float] = time.time,
        tz: tzinfo | None = None,
    ) -> None:
        self.store = store
        self.per_day = per_day
        self.per_month = per_month
        self.wall_clock = wall_clock
        self.tz = tz

    def usage(self) -> dict[str, Any]:
        day, month = period_keys(self.wall_clock(), self.tz)
        today, this_month = self.store.count_tiles_sessions(day, month)
        return {
            "day": day, "month": month,
            "today": today, "this_month": this_month,
            "per_day": self.per_day, "per_month": self.per_month,
        }

    def request(self, client: str | None) -> Grant:
        now = self.wall_clock()
        day, month = period_keys(now, self.tz)
        granted, reason, today, this_month = self.store.grant_tiles_session(
            now, day, month, self.per_day, self.per_month, client
        )
        usage = {
            "day": day, "month": month,
            "today": today, "this_month": this_month,
            "per_day": self.per_day, "per_month": self.per_month,
        }
        return Grant(granted, reason, usage)
