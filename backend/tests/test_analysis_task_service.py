from __future__ import annotations

import json
import sys
from pathlib import Path
from uuid import UUID

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.db.base import Base
from app.db.models.analysis_task import AnalysisTask
from app.db.models.user import User
from app.schemas.analysis import TaskOptions
from app.services.analysis_tasks import AnalysisTaskService, _ensure_project_root_on_path
from app.services.video_preparation import CalibrationFrame, VideoMetadata


class RecordingExecutor:
    def __init__(self) -> None:
        self.submit_count = 0

    def submit(self, fn: object, *args: object, **kwargs: object) -> None:
        self.submit_count += 1


@pytest.fixture
def service_parts(tmp_path: Path) -> tuple[AnalysisTaskService, sessionmaker[Session], RecordingExecutor]:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    executor = RecordingExecutor()

    def probe_video(path: Path) -> VideoMetadata:
        return VideoMetadata(
            filename=path.name,
            size_bytes=path.stat().st_size,
            duration_sec=12.5,
            width=1280,
            height=720,
            fps=30.0,
        )

    def extract_frames(path: Path, destination: Path, *, count: int = 3) -> list[CalibrationFrame]:
        assert path.is_file()
        destination.mkdir(parents=True, exist_ok=True)
        frame_path = destination / "candidate_1.jpg"
        frame_path.write_bytes(b"frame")
        return [
            CalibrationFrame(
                path=frame_path,
                timestamp_sec=0.625,
                width=1280,
                height=720,
            )
        ]

    service = AnalysisTaskService(
        session_factory=session_factory,
        executor=executor,
        storage_dir=tmp_path,
        prepare_court_fn=lambda _path: {"corners": None},
        probe_video_fn=probe_video,
        extract_calibration_frames_fn=extract_frames,
    )
    return service, session_factory, executor


@pytest.fixture
def users(
    service_parts: tuple[AnalysisTaskService, sessionmaker[Session], RecordingExecutor],
) -> tuple[UUID, UUID]:
    _service, session_factory, _executor = service_parts
    with session_factory() as session:
        owner = User(openid="analysis-owner", account_number="10000003")
        other = User(openid="analysis-other", account_number="10000004")
        session.add_all([owner, other])
        session.commit()
        return owner.id, other.id


def _complete_task(service: AnalysisTaskService, owner_id: UUID) -> AnalysisTask:
    task = service.create_draft(owner_id, TaskOptions())
    service.save_upload(task.id, owner_id, "video", "match.mp4", b"video")
    service.save_upload(task.id, owner_id, "template", "court.png", b"image")
    return service.save_corners(task.id, owner_id, [(0, 0), (100, 0), (100, 50), (0, 50)])


def test_enqueue_queues_complete_created_task_once(
    service_parts: tuple[AnalysisTaskService, sessionmaker[Session], RecordingExecutor],
    users: tuple[UUID, UUID],
) -> None:
    service, _session_factory, executor = service_parts
    owner_id, _other_id = users
    task = _complete_task(service, owner_id)

    queued = service.enqueue(task.id, owner_id)

    assert queued.status == "queued"
    assert executor.submit_count == 1


def test_video_upload_prepares_metadata_cover_and_template(
    service_parts: tuple[AnalysisTaskService, sessionmaker[Session], RecordingExecutor],
    users: tuple[UUID, UUID],
) -> None:
    service, _session_factory, _executor = service_parts
    owner_id, _other_id = users
    task = service.create_draft(owner_id, TaskOptions())

    prepared = service.save_upload(task.id, owner_id, "video", "match.mp4", b"video")

    assert prepared.stage == "calibration"
    assert prepared.video_metadata_json == {
        "filename": "video_match.mp4",
        "size_bytes": 5,
        "duration_sec": 12.5,
        "width": 1280,
        "height": 720,
        "fps": 30.0,
    }
    assert prepared.cover_path == prepared.template_path
    assert prepared.calibration_frames_json == [
        {
            "path": prepared.cover_path,
            "timestamp_sec": 0.625,
            "width": 1280,
            "height": 720,
        }
    ]
    assert service._absolute_path(prepared.cover_path).read_bytes() == b"frame"


@pytest.mark.parametrize("missing", ["video", "corners"])
def test_enqueue_rejects_task_missing_required_input(
    service_parts: tuple[AnalysisTaskService, sessionmaker[Session], RecordingExecutor],
    users: tuple[UUID, UUID],
    missing: str,
) -> None:
    service, _session_factory, executor = service_parts
    owner_id, _other_id = users
    task = service.create_draft(owner_id, TaskOptions())
    if missing != "video":
        service.save_upload(task.id, owner_id, "video", "match.mp4", b"video")
    if missing != "template":
        service.save_upload(task.id, owner_id, "template", "court.png", b"image")
    if missing != "corners":
        service.save_corners(task.id, owner_id, [(0, 0), (100, 0), (100, 50), (0, 50)])

    with pytest.raises(ValueError):
        service.enqueue(task.id, owner_id)

    assert executor.submit_count == 0


def test_get_task_hides_task_from_non_owner(
    service_parts: tuple[AnalysisTaskService, sessionmaker[Session], RecordingExecutor],
    users: tuple[UUID, UUID],
) -> None:
    service, _session_factory, _executor = service_parts
    owner_id, other_id = users
    task = service.create_draft(owner_id, TaskOptions())

    assert service.get_task(task.id, other_id) is None


def test_task_recovery_actions_preserve_source_and_private_media(
    service_parts: tuple[AnalysisTaskService, sessionmaker[Session], RecordingExecutor],
    users: tuple[UUID, UUID],
) -> None:
    service, session_factory, executor = service_parts
    owner_id, _other_id = users
    failed = _complete_task(service, owner_id)
    with session_factory() as session:
        stored = session.get(AnalysisTask, failed.id)
        assert stored is not None
        stored.status = "failed"
        stored.stage = "analysis"
        stored.error_message = "视频解码失败"
        session.commit()

    retried = service.retry(failed.id, owner_id)
    draft = service.reanalyze(failed.id, owner_id)

    assert retried.status == "queued"
    assert retried.source_task_id == failed.id
    assert retried.input_video_path != failed.input_video_path
    assert retried.template_path != failed.template_path
    assert service._absolute_path(retried.input_video_path).read_bytes() == b"video"
    assert executor.submit_count == 1
    assert draft.status == "created"
    assert draft.stage == "calibration"
    assert draft.source_task_id == failed.id
    assert draft.corners_json == failed.corners_json


def test_queued_task_can_be_cancelled_and_terminal_task_is_soft_deleted(
    service_parts: tuple[AnalysisTaskService, sessionmaker[Session], RecordingExecutor],
    users: tuple[UUID, UUID],
) -> None:
    service, _session_factory, _executor = service_parts
    owner_id, _other_id = users
    queued = service.enqueue(_complete_task(service, owner_id).id, owner_id)

    cancelled = service.cancel(queued.id, owner_id)
    service.soft_delete(cancelled.id, owner_id)

    assert cancelled.status == "cancelled"
    assert cancelled.stage == "cancelled"
    assert service.get_task(cancelled.id, owner_id) is None
    assert service._absolute_path(cancelled.input_video_path).is_file()


def test_corner_detection_can_return_no_corners_and_manual_save_requires_four_points(
    service_parts: tuple[AnalysisTaskService, sessionmaker[Session], RecordingExecutor],
    users: tuple[UUID, UUID],
) -> None:
    service, _session_factory, _executor = service_parts
    owner_id, _other_id = users
    task = service.create_draft(owner_id, TaskOptions())
    service.save_upload(task.id, owner_id, "template", "court.png", b"image")

    assert service.detect_template_corners(task.id, owner_id) is None

    with pytest.raises(ValueError):
        service.save_corners(task.id, owner_id, [(0, 0), (100, 0), (100, 50)])

    saved = service.save_corners(task.id, owner_id, [(0, 0), (100, 0), (100, 50), (0, 50)])
    assert saved.corners_json == [[0, 0], [100, 0], [100, 50], [0, 50]]


def test_settings_provide_task_storage_and_single_file_upload_limits() -> None:
    settings = Settings(database_url="mysql+pymysql://user:password@localhost:3306/database")

    assert Path(settings.analysis_storage_dir).parts[-2:] == ("outputs", "tasks")
    assert settings.max_video_upload_bytes > 0
    assert settings.max_template_upload_bytes > 0


def test_analysis_pipeline_import_path_is_available_from_backend_working_directory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_root = str(Path(__file__).resolve().parents[2])
    monkeypatch.setattr(sys, "path", [entry for entry in sys.path if entry != project_root])

    _ensure_project_root_on_path()

    assert sys.path[0] == project_root


def test_store_result_rewrites_metadata_paths_after_archiving(
    service_parts: tuple[AnalysisTaskService, sessionmaker[Session], RecordingExecutor],
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    service, _session_factory, _executor = service_parts
    task_id = UUID("00000000-0000-0000-0000-000000000001")
    source_dir = tmp_path / "webui_match"
    video_path = source_dir / "detect_match.mp4"
    detections_path = source_dir / "detections.jsonl"
    visualization_path = source_dir / "position_visualizations" / "heatmaps" / "match_heatmap.png"
    metadata_path = source_dir / "metadata.json"
    visualization_path.parent.mkdir(parents=True)
    video_path.write_bytes(b"video")
    detections_path.write_text("{}\n", encoding="utf-8")
    visualization_path.write_bytes(b"image")
    metadata_path.write_text(
        json.dumps(
            {"outputs": {"video": str(video_path), "detections": str(detections_path)}},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    stored = service._store_result(
        task_id,
        {
            "output_dir": str(source_dir),
            "video": str(video_path),
            "metadata": str(metadata_path),
            "detections": str(detections_path),
            "visualizations": [str(visualization_path)],
        },
    )

    result_prefix = f"{task_id}/result"
    assert stored == {
        "output_dir": result_prefix,
        "video": f"{result_prefix}/detect_match.mp4",
        "metadata": f"{result_prefix}/metadata.json",
        "detections": f"{result_prefix}/detections.jsonl",
        "visualizations": [f"{result_prefix}/position_visualizations/heatmaps/match_heatmap.png"],
    }
    assert (
        f"可视化结果已归档至: {tmp_path / str(task_id) / 'result' / 'position_visualizations'}"
        in capsys.readouterr().out
    )
    metadata = json.loads((tmp_path / str(task_id) / "result" / "metadata.json").read_text("utf-8"))
    assert metadata["outputs"] == {
        "directory": stored["output_dir"],
        "video": stored["video"],
        "detections": stored["detections"],
        "position_visualizations": f"{result_prefix}/position_visualizations",
    }


def test_store_result_archives_structured_product_artifacts(
    service_parts: tuple[AnalysisTaskService, sessionmaker[Session], RecordingExecutor],
    tmp_path: Path,
) -> None:
    service, _session_factory, _executor = service_parts
    task_id = UUID("00000000-0000-0000-0000-000000000002")
    source_dir = tmp_path / "webui_product_result"
    source_dir.mkdir()
    paths = {
        "video": source_dir / "detect_match.mp4",
        "metadata": source_dir / "metadata.json",
        "detections": source_dir / "detections.jsonl",
        "analytics": source_dir / "analytics.json",
        "highlights": source_dir / "highlights.json",
        "summary_csv": source_dir / "summary.csv",
        "report": source_dir / "report.html",
    }
    paths["video"].write_bytes(b"video")
    paths["metadata"].write_text(json.dumps({"outputs": {}}), encoding="utf-8")
    paths["detections"].write_text("{}\n", encoding="utf-8")
    paths["analytics"].write_text("{}", encoding="utf-8")
    paths["highlights"].write_text("{}", encoding="utf-8")
    paths["summary_csv"].write_text("scope,metric\n", encoding="utf-8")
    paths["report"].write_text("<html></html>", encoding="utf-8")

    stored = service._store_result(
        task_id,
        {"output_dir": str(source_dir), "visualizations": [], **{key: str(path) for key, path in paths.items()}},
    )

    prefix = f"{task_id}/result"
    assert stored["analytics"] == f"{prefix}/analytics.json"
    assert stored["highlights"] == f"{prefix}/highlights.json"
    assert stored["summary_csv"] == f"{prefix}/summary.csv"
    assert stored["report"] == f"{prefix}/report.html"
    for key in ("analytics", "highlights", "summary_csv", "report"):
        assert (tmp_path / stored[key]).is_file()


@pytest.mark.parametrize(
    ("relative_path", "stale_message"),
    [
        ("badminton_analysis/visualization/player_positions_zh.py", "可视化结果已保存至:"),
        ("badminton_analysis/visualization/player_positions_en.py", "visualizations saved to:"),
    ],
)
def test_visualization_modules_do_not_log_pre_archive_output_paths(
    relative_path: str,
    stale_message: str,
) -> None:
    project_root = Path(__file__).resolve().parents[2]

    assert stale_message not in (project_root / relative_path).read_text(encoding="utf-8")
