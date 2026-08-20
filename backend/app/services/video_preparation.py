"""Prepare uploaded videos for analysis processing."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class VideoMetadata:
    filename: str
    size_bytes: int
    duration_sec: float
    width: int
    height: int
    fps: float

    def to_dict(self) -> dict[str, str | int | float]:
        return {
            "filename": self.filename,
            "size_bytes": self.size_bytes,
            "duration_sec": self.duration_sec,
            "width": self.width,
            "height": self.height,
            "fps": self.fps,
        }


@dataclass(frozen=True)
class CalibrationFrame:
    path: Path
    timestamp_sec: float
    width: int
    height: int


def _cv2(cv2_module: Any | None) -> Any:
    if cv2_module is not None:
        return cv2_module
    import cv2

    return cv2


def probe_video(video_path: Path, *, cv2_module: Any | None = None) -> VideoMetadata:
    cv2 = _cv2(cv2_module)
    capture = cv2.VideoCapture(str(video_path))
    try:
        if not capture.isOpened():
            raise ValueError("VIDEO_DECODE_FAILED: video cannot be opened")
        fps = float(capture.get(cv2.CAP_PROP_FPS))
        frame_count = float(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        if fps <= 0 or frame_count <= 0 or width <= 0 or height <= 0:
            raise ValueError("VIDEO_DECODE_FAILED: video metadata is invalid")
        return VideoMetadata(
            filename=video_path.name,
            size_bytes=video_path.stat().st_size,
            duration_sec=frame_count / fps,
            width=width,
            height=height,
            fps=fps,
        )
    finally:
        capture.release()


def extract_calibration_frames(
    video_path: Path,
    destination: Path,
    *,
    count: int = 3,
    cv2_module: Any | None = None,
) -> list[CalibrationFrame]:
    if count < 1:
        raise ValueError("count must be positive")
    cv2 = _cv2(cv2_module)
    metadata = probe_video(video_path, cv2_module=cv2)
    destination.mkdir(parents=True, exist_ok=True)
    capture = cv2.VideoCapture(str(video_path))
    try:
        if not capture.isOpened():
            raise ValueError("VIDEO_DECODE_FAILED: video cannot be opened")
        frames: list[CalibrationFrame] = []
        for index in range(count):
            timestamp_sec = metadata.duration_sec * (0.05 + index * 0.3)
            capture.set(cv2.CAP_PROP_POS_MSEC, timestamp_sec * 1000)
            success, image = capture.read()
            if not success:
                raise ValueError("VIDEO_DECODE_FAILED: calibration frame extraction failed")
            path = destination / f"candidate_{index + 1}.jpg"
            if not cv2.imwrite(str(path), image):
                raise ValueError("VIDEO_DECODE_FAILED: calibration frame write failed")
            frames.append(
                CalibrationFrame(
                    path=path,
                    timestamp_sec=timestamp_sec,
                    width=metadata.width,
                    height=metadata.height,
                )
            )
        return frames
    finally:
        capture.release()


def validate_video(video_path: Path) -> bool:
    """Check if video file is valid."""
    return video_path.exists() and video_path.stat().st_size > 0


def get_video_info(video_path: Path) -> dict:
    """Get basic video information."""
    return {
        "path": str(video_path),
        "size": video_path.stat().st_size,
    }
