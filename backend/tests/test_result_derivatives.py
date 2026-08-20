from pathlib import Path

import pytest

from app.services.result_derivatives import clip_cache_filename, create_video_clip


def test_clip_generation_uses_argument_list_and_atomic_destination(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    destination = tmp_path / "clips" / "highlight-1.mp4"
    source.write_bytes(b"source")
    calls = []

    def runner(args: list[str], **kwargs: object) -> None:
        calls.append((args, kwargs))
        Path(args[-1]).write_bytes(b"clip")

    result = create_video_clip(source, destination, 2.5, 9.0, runner=runner)
    assert result == destination
    assert destination.read_bytes() == b"clip"
    assert calls[0][0][0] == "ffmpeg"
    assert calls[0][0][calls[0][0].index("-ss") + 1] == "2.500"
    assert calls[0][0][calls[0][0].index("-t") + 1] == "6.500"
    assert calls[0][1]["check"] is True
    assert "shell" not in calls[0][1]


@pytest.mark.parametrize(("start", "end"), [(5, 5), (8, 2), (0, 301)])
def test_clip_generation_rejects_invalid_or_excessive_ranges(tmp_path: Path, start: float, end: float) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    with pytest.raises(ValueError):
        create_video_clip(source, tmp_path / "clip.mp4", start, end)


def test_clip_cache_changes_when_user_edits_the_range() -> None:
    assert clip_cache_filename("highlight-1", 2, 8) != clip_cache_filename("highlight-1", 3, 8)
