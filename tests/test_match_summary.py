from __future__ import annotations

import json
from pathlib import Path

from badminton_analysis.analysis.match_summary import (
    build_match_analytics,
    write_analysis_artifacts,
)


def _write_fixture(tmp_path: Path) -> tuple[Path, Path]:
    detections_path = tmp_path / "detections.jsonl"
    records = [
        (1, [1.0, 1.0], [5.0, 12.0]),
        (2, [1.1, 1.0], [4.9, 12.0]),
        (3, [1.2, 1.0], [4.8, 12.0]),
        (105, [2.0, 5.0], [4.0, 8.0]),
        (106, [2.1, 5.0], [3.9, 8.0]),
        (107, [2.2, 5.0], [3.8, 8.0]),
    ]
    detections_path.write_text(
        "\n".join(
            json.dumps({
                "schema_version": "1.0",
                "frame": frame,
                "time_sec": frame / 10,
                "players": {
                    "upper": {"court": upper},
                    "lower": {"court": lower},
                },
            })
            for frame, upper, lower in records
        ) + "\n",
        encoding="utf-8",
    )
    metadata_path = tmp_path / "metadata.json"
    metadata_path.write_text(
        json.dumps({
            "schema_version": "1.0",
            "video": {"name": "fixture", "fps": 10.0, "total_frames": 200, "duration_sec": 20.0, "width": 1280, "height": 720},
            "court": {"coordinate_system": {"unit": "meter", "width": 6.1, "length": 13.4}},
        }),
        encoding="utf-8",
    )
    return detections_path, metadata_path


def test_build_match_analytics_is_recomputable_and_scoped(tmp_path: Path) -> None:
    detections_path, metadata_path = _write_fixture(tmp_path)
    result = build_match_analytics(detections_path, metadata_path, rally_gap_frames=100, min_rally_frames=3)
    assert result["schema_version"] == "2.0"
    assert result["match"]["rally_count"]["value"] == 2
    assert result["players"]["upper"]["distance_m"]["value"] == 0.4
    assert result["quality"]["confidence"] == "high"


def test_write_analysis_artifacts_exports_explained_recommendations(tmp_path: Path) -> None:
    detections_path, metadata_path = _write_fixture(tmp_path)
    heatmap = tmp_path / "result" / "position_visualizations" / "heatmaps" / "match_heatmap.png"
    heatmap.parent.mkdir(parents=True)
    heatmap.write_bytes(b"png-image")
    paths = write_analysis_artifacts(detections_path, metadata_path, tmp_path / "result", rally_gap_frames=100, min_rally_frames=3)
    assert set(paths) == {"analytics", "highlights", "summary_csv", "report"}
    analytics = json.loads(Path(paths["analytics"]).read_text(encoding="utf-8"))
    assert analytics["match"]["rally_count"]["value"] == 2
    report = Path(paths["report"]).read_text(encoding="utf-8")
    assert "fixture" in report
    assert "data:image/png;base64," in report
