"""YouTube URL parsing for the video library (the bridge never talks to YouTube itself)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import parse_qs, urlparse

VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
HOSTS = {"youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"}
PATH_PREFIXES = ("shorts", "embed", "live", "v")


@dataclass(frozen=True, slots=True)
class YouTubeRef:
    video_id: str
    start_s: float = 0.0


def _seconds(t: str) -> float:
    """`t`/`start` values: 90, 90s, 1m30s, 1h2m3s."""
    if t.isdigit():
        return float(t)
    m = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?", t)
    if not m or not any(m.groups()):
        return 0.0
    h, mi, s = (int(g) if g else 0 for g in m.groups())
    return float(h * 3600 + mi * 60 + s)


def parse_youtube_url(text: str) -> YouTubeRef:
    """The video id (and start time) from a YouTube link or a bare 11-character id.

    Raises ValueError for anything else.
    """
    text = text.strip()
    if VIDEO_ID.match(text):
        return YouTubeRef(text)
    url = urlparse(text if "://" in text else f"https://{text}")
    host = (url.hostname or "").lower().removeprefix("www.")
    query = parse_qs(url.query)
    parts = [p for p in url.path.split("/") if p]
    video_id = None
    if host == "youtu.be" and parts:
        video_id = parts[0]
    elif host in HOSTS:
        if parts[:1] == ["watch"]:
            video_id = (query.get("v") or [None])[0]
        elif len(parts) >= 2 and parts[0] in PATH_PREFIXES:
            video_id = parts[1]
    if not video_id or not VIDEO_ID.match(video_id):
        raise ValueError("not a YouTube video link")
    start = (query.get("t") or query.get("start") or ["0"])[0]
    return YouTubeRef(video_id, _seconds(start))
