"""Open-world progression: experience, levels and achievements of the walker (one character
across all worlds).

XP comes from three places:
- walking: every metre on the pad counts (all sessions, any world), 1 XP per 10 m;
- discoveries in the open world: places, provinces and biomes, first time per world;
- achievements: data-driven goals (ACHIEVEMENTS) on distance, sessions, streaks and
  discoveries, each worth some XP once unlocked. Unlocks are stored, so they are never lost.

Pure functions here; storage.py keeps discoveries and unlocks, server.py serves the profile.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

WALK_XP_PER_M = 0.1

# XP for a first discovery. Place ids are "<kind>-<n>" (made by the web app's generator).
PLACE_XP = {"city": 100, "castle": 100, "village": 50, "ruins": 75, "waterfall": 75, "windmill": 25}
PROVINCE_XP = 150
BIOME_XP = 100
BIOMES = ("forest", "ruins", "meadow", "fields", "falls")
PLACE_KEY = re.compile(r"^(city|village|castle|ruins|windmill|waterfall)-\d{1,4}$")


def discovery_xp(kind: str, key: str) -> int | None:
    """XP for discovering (kind, key), or None when it is not a valid discovery."""
    if kind == "place":
        m = PLACE_KEY.match(key)
        return PLACE_XP[m.group(1)] if m else None
    if kind == "province":
        return PROVINCE_XP if key.isdigit() and len(key) <= 3 else None
    if kind == "biome":
        return BIOME_XP if key in BIOMES else None
    return None


def level_start(level: int) -> int:
    """Total XP needed to reach `level` (level 1 needs 0, 2 needs 100, 3 needs 300, ...)."""
    return 50 * level * (level - 1)


def level_for(xp: float) -> int:
    level = 1
    while xp >= level_start(level + 1):
        level += 1
    return level


@dataclass(frozen=True, slots=True)
class Achievement:
    id: str
    title: str
    description: str
    metric: str
    target: float
    xp: int


# Metrics: distance_km, longest_session_km, longest_streak_days, sessions, places, cities,
# villages, castles, ruins, waterfalls, windmills, provinces, biomes.
ACHIEVEMENTS: tuple[Achievement, ...] = (
    Achievement("first-km", "First steps", "Walk 1 km", "distance_km", 1, 50),
    Achievement("wanderer", "Wanderer", "Walk 10 km in total", "distance_km", 10, 150),
    Achievement("marathon", "A marathon, in pieces", "Walk 42.2 km in total", "distance_km", 42.2, 400),
    Achievement("centurion", "Centurion", "Walk 100 km in total", "distance_km", 100, 800),
    Achievement("long-road", "The long road", "Walk 250 km in total", "distance_km", 250, 1500),
    Achievement("thousand", "A thousand kilometres", "Walk 1000 km in total", "distance_km", 1000, 4000),
    Achievement("good-walk", "A good long walk", "Walk 5 km in one session", "longest_session_km", 5, 200),
    Achievement("ten-in-one", "Ten in one go", "Walk 10 km in one session", "longest_session_km", 10, 400),
    Achievement("half-marathon", "Half marathon", "Walk 21.1 km in one session", "longest_session_km", 21.1, 800),
    Achievement("habit", "A habit", "Walk 3 days in a row", "longest_streak_days", 3, 100),
    Achievement("week", "A whole week", "Walk 7 days in a row", "longest_streak_days", 7, 300),
    Achievement("unstoppable", "Unstoppable", "Walk 30 days in a row", "longest_streak_days", 30, 1500),
    Achievement("regular", "Regular", "Finish 10 walks", "sessions", 10, 100),
    Achievement("devoted", "Devoted", "Finish 50 walks", "sessions", 50, 400),
    Achievement("city-lights", "City lights", "Reach a city", "cities", 1, 50),
    Achievement("village-hopper", "Village hopper", "Visit 5 villages", "villages", 5, 150),
    Achievement("knock-knock", "Knock knock", "Reach a castle", "castles", 1, 50),
    Achievement("castellan", "Castellan", "Visit 5 castles", "castles", 5, 300),
    Achievement("waterfalls", "Chasing waterfalls", "Find 3 waterfalls", "waterfalls", 3, 150),
    Achievement("elf-friend", "Elf friend", "Find 3 elven ruins", "ruins", 3, 150),
    Achievement("windmills", "Tilting at windmills", "Find 3 windmills", "windmills", 3, 100),
    Achievement("border-crosser", "Border crosser", "Enter 3 provinces", "provinces", 3, 150),
    Achievement("realm-walker", "Realm walker", "Enter 10 provinces", "provinces", 10, 500),
    Achievement("every-corner", "Every corner", "Walk in all 5 kinds of land", "biomes", 5, 250),
    Achievement("explorer", "Explorer", "Discover 25 places", "places", 25, 300),
    Achievement("cartographer", "Cartographer", "Discover 75 places", "places", 75, 1000),
)


def metrics(stats: dict[str, Any], live_m: float, discoveries: list[dict[str, Any]]) -> dict[str, float]:
    """Everything the achievements look at. `stats` is stats.compute_stats() of finished sessions;
    `live_m` the open session's distance; `discoveries` all discoveries in all worlds."""
    places = [d for d in discoveries if d["kind"] == "place"]
    kind_of = [d["key"].split("-")[0] for d in places]
    best = (stats["personal_bests"]["longest_distance_m"] or {}).get("value") or 0
    return {
        "distance_km": (stats["all_time"]["distance_m"] + live_m) / 1000,
        "longest_session_km": max(best, live_m) / 1000,
        "longest_streak_days": stats["streaks"]["longest_days"],
        "sessions": stats["all_time"]["sessions"],
        "places": len(places),
        "cities": kind_of.count("city"),
        "villages": kind_of.count("village"),
        "castles": kind_of.count("castle"),
        "ruins": kind_of.count("ruins"),
        "waterfalls": kind_of.count("waterfall"),
        "windmills": kind_of.count("windmill"),
        "provinces": sum(1 for d in discoveries if d["kind"] == "province"),
        "biomes": len({d["key"] for d in discoveries if d["kind"] == "biome"}),
    }


def newly_unlocked(values: dict[str, float], unlocked: dict[str, float]) -> list[Achievement]:
    return [a for a in ACHIEVEMENTS if a.id not in unlocked and values[a.metric] >= a.target]


def profile(values: dict[str, float], discoveries: list[dict[str, Any]], unlocked: dict[str, float]) -> dict[str, Any]:
    """The walker's level, XP and achievements. `unlocked` maps achievement id -> unlock time."""
    walking = int(values["distance_km"] * 1000 * WALK_XP_PER_M)
    found = sum(int(d["xp"]) for d in discoveries)
    earned = sum(a.xp for a in ACHIEVEMENTS if a.id in unlocked)
    xp = walking + found + earned
    level = level_for(xp)
    return {
        "xp": xp,
        "level": level,
        "level_start_xp": level_start(level),
        "next_level_xp": level_start(level + 1),
        "breakdown": {"walking": walking, "discoveries": found, "achievements": earned},
        "metrics": {k: round(v, 3) for k, v in values.items()},
        "achievements": [
            {
                "id": a.id, "title": a.title, "description": a.description, "xp": a.xp,
                "metric": a.metric, "target": a.target,
                "progress": round(min(values[a.metric], a.target), 3),
                "unlocked_at": unlocked.get(a.id),
            }
            for a in ACHIEVEMENTS
        ],
    }
