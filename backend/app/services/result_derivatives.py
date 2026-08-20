from __future__ import annotations

import subprocess
import hashlib
from collections.abc import Callable
from pathlib import Path
from typing import Any


def clip_cache_filename(highlight_id: str, start_sec: float, end_sec: float) -> str:
    cache_key = f"{highlight_id}:{float(start_sec):.3f}:{float(end_sec):.3f}"
    return hashlib.sha256(cache_key.encode("utf-8")).hexdigest()[:20]


def create_video_clip(
    source: Path,
    destination: Path,
    start_sec: float,
    end_sec: float,
    *,
    source_duration_sec: float | None = None,
    runner: Callable[..., Any] = subprocess.run,
) -> Path:
    start = float(start_sec)
    end = float(end_sec)
    duration = end - start
    if start < 0 or duration <= 0:
        raise ValueError("clip end must be later than its non-negative start")
    if duration > 300:
        raise ValueError("clip duration must not exceed 300 seconds")
    if source_duration_sec is not None and end > float(source_duration_sec):
        raise ValueError("clip range exceeds the source video duration")
    if not source.is_file():
        raise ValueError("source result video was not found")
    if destination.is_file():
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".part.mp4")
    runner(
        [
            "ffmpeg", "-y", "-ss", f"{start:.3f}", "-i", str(source),
            "-t", f"{duration:.3f}", "-c:v", "libx264", "-preset", "veryfast",
            "-c:a", "aac", "-movflags", "+faststart", str(temporary),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=600,
    )
    if not temporary.is_file() or temporary.stat().st_size <= 0:
        raise ValueError("ffmpeg did not produce a valid clip")
    temporary.replace(destination)
    return destination
