from __future__ import annotations

from pathlib import Path

import pytest

from app.services.video_preparation import extract_calibration_frames, probe_video


class FakeCapture:
    def __init__(self, opened: bool = True) -> None:
        self.opened = opened
        self.position_ms = 0.0

    def isOpened(self) -> bool:
        return self.opened

    def get(self, property_id: int) -> float:
        return {1: 10.0, 2: 20.0, 3: 64.0, 4: 36.0}[property_id]

    def set(self, property_id: int, value: float) -> bool:
        assert property_id == 5
        self.position_ms = value
        return True

    def read(self) -> tuple[bool, bytes]:
        return self.opened, f"frame-at-{self.position_ms}".encode()

    def release(self) -> None:
        pass


class FakeCv2:
    CAP_PROP_FPS = 1
    CAP_PROP_FRAME_COUNT = 2
    CAP_PROP_FRAME_WIDTH = 3
    CAP_PROP_FRAME_HEIGHT = 4
    CAP_PROP_POS_MSEC = 5

    def __init__(self, opened: bool = True) -> None:
        self.opened = opened

    def VideoCapture(self, _path: str) -> FakeCapture:
        return FakeCapture(self.opened)

    @staticmethod
    def imwrite(path: str, frame: bytes) -> bool:
        Path(path).write_bytes(frame)
        return True


@pytest.fixture
def sample_video(tmp_path: Path) -> Path:
    path = tmp_path / "landscape-match.mp4"
    path.write_bytes(b"video-fixture")
    return path


def test_probe_video_returns_upload_preview_metadata(sample_video: Path) -> None:
    metadata = probe_video(sample_video, cv2_module=FakeCv2())
    assert metadata.filename == "landscape-match.mp4"
    assert metadata.size_bytes == len(b"video-fixture")
    assert metadata.duration_sec == 2.0
    assert metadata.width == 64
    assert metadata.height == 36
    assert metadata.fps == 10.0


def test_extract_calibration_frames_keeps_source_dimensions(sample_video: Path, tmp_path: Path) -> None:
    frames = extract_calibration_frames(sample_video, tmp_path / "frames", count=3, cv2_module=FakeCv2())
    assert len(frames) == 3
    assert [frame.timestamp_sec for frame in frames] == [0.1, 0.7, 1.3]
    assert all(frame.path.is_file() for frame in frames)
    assert all(frame.width == 64 and frame.height == 36 for frame in frames)


def test_invalid_video_has_actionable_error(sample_video: Path) -> None:
    with pytest.raises(ValueError, match="VIDEO_DECODE_FAILED"):
        probe_video(sample_video, cv2_module=FakeCv2(opened=False))
