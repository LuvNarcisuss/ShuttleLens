from __future__ import annotations

import json
import shutil
import sys
from datetime import UTC, datetime
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.db.models.analysis_task import AnalysisTask
from app.db.session import SessionLocal
from app.schemas.analysis import TaskOptions
from app.services.video_preparation import (
    CalibrationFrame,
    VideoMetadata,
    extract_calibration_frames,
    probe_video,
)


_PROJECT_ROOT = Path(__file__).resolve().parents[3]


def _ensure_project_root_on_path() -> None:
    project_root = str(_PROJECT_ROOT)
    if project_root not in sys.path:
        sys.path.insert(0, project_root)


def _prepare_court(template_path: str) -> dict[str, Any]:
    _ensure_project_root_on_path()
    from webui.pipeline import prepare_court

    return prepare_court(template_path)


def _run_analysis(
    video_path: str,
    template_path: str,
    corners: list[tuple[int, int]],
    options: dict[str, Any],
    progress_cb: Callable[[int, int], None],
) -> dict[str, Any]:
    _ensure_project_root_on_path()
    from webui.pipeline import run_analysis

    return run_analysis(video_path, template_path, corners, options, progress_cb=progress_cb)


class AnalysisTaskService:
    def __init__(
        self,
        session_factory: sessionmaker[Session] = SessionLocal,
        executor: ThreadPoolExecutor | None = None,
        storage_dir: str | Path | None = None,
        prepare_court_fn: Callable[[str], dict[str, Any]] | None = None,
        run_analysis_fn: Callable[..., dict[str, Any]] | None = None,
        probe_video_fn: Callable[[Path], VideoMetadata] | None = None,
        extract_calibration_frames_fn: Callable[..., list[CalibrationFrame]] | None = None,
    ) -> None:
        settings = get_settings()
        self._session_factory = session_factory
        self._executor = executor or ThreadPoolExecutor(max_workers=1)
        self._storage_dir = Path(storage_dir or settings.analysis_storage_dir).resolve()
        self._prepare_court = prepare_court_fn or _prepare_court
        self._run_analysis = run_analysis_fn or _run_analysis
        self._probe_video = probe_video_fn or probe_video
        self._extract_calibration_frames = (
            extract_calibration_frames_fn or extract_calibration_frames
        )
        self._max_video_upload_bytes = settings.max_video_upload_bytes
        self._max_template_upload_bytes = settings.max_template_upload_bytes

    def create_draft(self, user_id: UUID, options: TaskOptions | None = None) -> AnalysisTask:
        task = AnalysisTask(
            user_id=user_id,
            name="未命名分析",
            stage="draft",
            options_json=(options or TaskOptions()).model_dump(),
        )
        with self._session_factory() as session:
            session.add(task)
            session.commit()
            session.refresh(task)
            return task

    def get_task(self, task_id: UUID, user_id: UUID) -> AnalysisTask | None:
        with self._session_factory() as session:
            task = self._owned_task(session, task_id, user_id)
            if task is None:
                return None
            session.expunge(task)
            return task

    def save_upload(
        self,
        task_id: UUID,
        user_id: UUID,
        upload_type: str,
        filename: str,
        content: bytes,
    ) -> AnalysisTask:
        if upload_type not in {"video", "template"}:
            raise ValueError("upload_type must be video or template")
        if not isinstance(content, bytes):
            raise ValueError("upload content must be bytes")
        max_bytes = (
            self._max_video_upload_bytes if upload_type == "video" else self._max_template_upload_bytes
        )
        if len(content) > max_bytes:
            raise ValueError("upload exceeds the configured size limit")

        safe_filename = Path(filename).name
        if not safe_filename or safe_filename in {".", ".."}:
            raise ValueError("filename is required")

        with self._session_factory() as session:
            task = self._require_owned_task(session, task_id, user_id)
            if task.status != "created":
                raise ValueError("uploads can only be changed while the task is created")
            path = self._task_dir(task.id) / "input" / f"{upload_type}_{safe_filename}"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            relative_path = self._relative_path(path)
            if upload_type == "video":
                task.input_video_path = relative_path
                try:
                    metadata = self._probe_video(path)
                    frames = self._extract_calibration_frames(
                        path,
                        self._task_dir(task.id) / "calibration",
                        count=3,
                    )
                except ValueError as error:
                    task.stage = "draft"
                    task.error_code = str(error).split(":", 1)[0]
                    task.error_message = str(error).split(":", 1)[-1].strip()
                    task.recovery_hint = "请重新选择可正常播放的横屏视频。"
                    session.commit()
                    raise
                task.video_metadata_json = metadata.to_dict()
                task.calibration_frames_json = [
                    {
                        "path": self._relative_path(frame.path),
                        "timestamp_sec": frame.timestamp_sec,
                        "width": frame.width,
                        "height": frame.height,
                    }
                    for frame in frames
                ]
                task.cover_path = task.calibration_frames_json[0]["path"]
                task.template_path = task.cover_path
                task.stage = "calibration"
                task.error_code = None
                task.error_message = None
                task.recovery_hint = None
            else:
                task.template_path = relative_path
                task.stage = "calibration"
            session.commit()
            session.refresh(task)
            return task

    def detect_template_corners(self, task_id: UUID, user_id: UUID) -> list[tuple[int, int]] | None:
        with self._session_factory() as session:
            task = self._require_owned_task(session, task_id, user_id)
            if not task.template_path:
                raise ValueError("a template upload is required before corner detection")
            template_path = self._absolute_path(task.template_path)

        try:
            detected = self._prepare_court(str(template_path)).get("corners")
        except Exception:
            return None
        if not detected:
            return None
        return [tuple(map(int, point)) for point in detected]

    def save_corners(
        self, task_id: UUID, user_id: UUID, corners: list[tuple[int, int]]
    ) -> AnalysisTask:
        normalized = self._normalize_corners(corners)
        with self._session_factory() as session:
            task = self._require_owned_task(session, task_id, user_id)
            if task.status != "created":
                raise ValueError("corners can only be changed while the task is created")
            task.corners_json = normalized
            task.stage = "ready"
            session.commit()
            session.refresh(task)
            return task

    def enqueue(self, task_id: UUID, user_id: UUID) -> AnalysisTask:
        with self._session_factory() as session:
            task = self._require_owned_task(session, task_id, user_id)
            if task.status != "created":
                raise ValueError("only created tasks can be queued")
            if not task.input_video_path or not task.template_path or not task.corners_json:
                raise ValueError("video, template, and four corners are required before queueing")
            self._normalize_corners(task.corners_json)
            task.status = "queued"
            task.stage = "queued"
            task.progress = 0
            session.commit()
            session.refresh(task)
            queued_task_id = task.id
            session.expunge(task)

        self._executor.submit(self._run_task, queued_task_id)
        return task

    def _run_task(self, task_id: UUID) -> None:
        with self._session_factory() as session:
            task = session.get(AnalysisTask, task_id)
            if task is None or task.status != "queued":
                return
            task.status = "running"
            task.stage = "analysis"
            task.progress = 0
            session.commit()
            video_path = self._absolute_path(task.input_video_path)
            template_path = self._absolute_path(task.template_path)
            corners = self._normalize_corners(task.corners_json)
            options = TaskOptions(**task.options_json).model_dump()

        try:
            result = self._run_analysis(
                str(video_path), str(template_path), corners, options, self._progress_callback(task_id)
            )
            stored_result = self._store_result(task_id, result)
        except Exception as error:
            self._mark_failed(task_id, error)
            return

        with self._session_factory() as session:
            task = session.get(AnalysisTask, task_id)
            if task is None:
                return
            task.status = "succeeded"
            task.stage = "completed"
            task.progress = 100
            task.result_json = stored_result
            task.error_message = None
            task.error_code = None
            task.recovery_hint = None
            session.commit()

    def rename(self, task_id: UUID, user_id: UUID, name: str) -> AnalysisTask:
        normalized = name.strip()
        if not normalized or len(normalized) > 160:
            raise ValueError("task name must contain 1 to 160 characters")
        with self._session_factory() as session:
            task = self._require_owned_task(session, task_id, user_id)
            task.name = normalized
            session.commit()
            session.refresh(task)
            return task

    def cancel(self, task_id: UUID, user_id: UUID) -> AnalysisTask:
        with self._session_factory() as session:
            task = self._require_owned_task(session, task_id, user_id)
            if task.status not in {"created", "uploading", "queued"}:
                raise ValueError("only draft, uploading, or queued tasks can be cancelled")
            task.status = "cancelled"
            task.stage = "cancelled"
            task.error_message = None
            task.error_code = None
            task.recovery_hint = None
            session.commit()
            session.refresh(task)
            return task

    def retry(self, task_id: UUID, user_id: UUID) -> AnalysisTask:
        cloned = self._clone_task(task_id, user_id, require_statuses={"failed"})
        return self.enqueue(cloned.id, user_id)

    def reanalyze(self, task_id: UUID, user_id: UUID) -> AnalysisTask:
        return self._clone_task(
            task_id,
            user_id,
            require_statuses={"failed", "cancelled", "succeeded"},
        )

    def soft_delete(self, task_id: UUID, user_id: UUID) -> None:
        with self._session_factory() as session:
            task = self._require_owned_task(session, task_id, user_id)
            if task.status in {"uploading", "queued", "running", "publishing"}:
                raise ValueError("active tasks must be cancelled or completed before deletion")
            task.deleted_at = datetime.now(UTC)
            session.commit()

    def _clone_task(
        self,
        task_id: UUID,
        user_id: UUID,
        *,
        require_statuses: set[str],
    ) -> AnalysisTask:
        with self._session_factory() as session:
            source = self._require_owned_task(session, task_id, user_id)
            if source.status not in require_statuses:
                allowed = ", ".join(sorted(require_statuses))
                raise ValueError(f"task must have one of these statuses: {allowed}")
            clone = AnalysisTask(
                user_id=user_id,
                name=f"{source.name}（重新分析）",
                status="created",
                stage="calibration",
                options_json=dict(source.options_json or {}),
                corners_json=[list(point) for point in source.corners_json] if source.corners_json else None,
                video_metadata_json=dict(source.video_metadata_json or {}),
                calibration_frames_json=[],
                source_task_id=source.id,
            )
            session.add(clone)
            session.flush()
            for field_name in ("input_video_path", "template_path"):
                source_relative = getattr(source, field_name)
                if not source_relative:
                    continue
                source_path = self._absolute_path(source_relative)
                destination = self._task_dir(clone.id) / "input" / source_path.name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source_path, destination)
                setattr(clone, field_name, self._relative_path(destination))
            if source.cover_path and clone.template_path:
                clone.cover_path = clone.template_path
                clone.calibration_frames_json = [
                    {
                        "path": clone.template_path,
                        "timestamp_sec": 0.0,
                        "width": int((clone.video_metadata_json or {}).get("width") or 0),
                        "height": int((clone.video_metadata_json or {}).get("height") or 0),
                    }
                ]
            session.commit()
            session.refresh(clone)
            return clone

    def _progress_callback(self, task_id: UUID) -> Callable[[int, int], None]:
        def update_progress(completed: int, total: int) -> None:
            if total <= 0:
                return
            progress = min(99, max(0, int(completed * 100 / total)))
            with self._session_factory() as session:
                task = session.get(AnalysisTask, task_id)
                if task is not None and task.status == "running":
                    task.progress = progress
                    session.commit()

        return update_progress

    def _mark_failed(self, task_id: UUID, error: Exception) -> None:
        with self._session_factory() as session:
            task = session.get(AnalysisTask, task_id)
            if task is None:
                return
            task.status = "failed"
            task.stage = "failed"
            detail = str(error).strip()
            task.error_message = f"analysis failed: {type(error).__name__}" + (f": {detail}" if detail else "")
            task.error_code = f"ANALYSIS_{type(error).__name__.upper()}"
            task.recovery_hint = "请检查视频和校准信息后重试，或重新分析并调整参数。"
            session.commit()

    def _store_result(self, task_id: UUID, result: dict[str, Any]) -> dict[str, Any]:
        source_dir = self._resolve_pipeline_path(result["output_dir"])
        destination_dir = self._task_dir(task_id) / "result"
        destination_dir.parent.mkdir(parents=True, exist_ok=True)
        if destination_dir.exists():
            raise ValueError("task result directory already exists")
        shutil.move(str(source_dir), str(destination_dir))

        stored: dict[str, Any] = {"output_dir": self._relative_path(destination_dir), "visualizations": []}
        for key in (
            "video",
            "metadata",
            "detections",
            "analytics",
            "highlights",
            "summary_csv",
            "report",
        ):
            if result.get(key):
                stored[key] = self._move_result_path(result[key], source_dir, destination_dir)
        for path in result.get("visualizations", []):
            stored["visualizations"].append(self._move_result_path(path, source_dir, destination_dir))
        self._update_archived_metadata(stored, destination_dir)
        return stored

    def _update_archived_metadata(self, stored: dict[str, Any], destination_dir: Path) -> None:
        metadata_path = self._absolute_path(stored["metadata"])
        with metadata_path.open(encoding="utf-8") as metadata_file:
            metadata = json.load(metadata_file)

        outputs = metadata.setdefault("outputs", {})
        outputs["directory"] = stored["output_dir"]
        for key in (
            "video",
            "detections",
            "analytics",
            "highlights",
            "summary_csv",
            "report",
        ):
            if key in stored:
                outputs[key] = stored[key]

        visualizations_dir = destination_dir / "position_visualizations"
        if visualizations_dir.is_dir():
            outputs["position_visualizations"] = self._relative_path(visualizations_dir)
            print(f"可视化结果已归档至: {visualizations_dir}")

        metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")

    def _move_result_path(self, path: str, source_dir: Path, destination_dir: Path) -> str:
        source_path = self._resolve_pipeline_path(path)
        try:
            relative_to_output = source_path.relative_to(source_dir)
        except ValueError as error:
            raise ValueError("pipeline result path is outside its output directory") from error
        return self._relative_path(destination_dir / relative_to_output)

    def _task_dir(self, task_id: UUID) -> Path:
        return self._storage_dir / str(task_id)

    def _relative_path(self, path: Path) -> str:
        return path.resolve().relative_to(self._storage_dir).as_posix()

    def _absolute_path(self, relative_path: str) -> Path:
        path = (self._storage_dir / relative_path).resolve()
        try:
            path.relative_to(self._storage_dir)
        except ValueError as error:
            raise ValueError("stored path is outside analysis storage") from error
        return path

    @staticmethod
    def _resolve_pipeline_path(path: str) -> Path:
        candidate = Path(path)
        return candidate.resolve() if candidate.is_absolute() else (Path.cwd() / candidate).resolve()

    @staticmethod
    def _normalize_corners(corners: list[Any] | None) -> list[list[int]]:
        if not corners or len(corners) != 4:
            raise ValueError("exactly four corners are required")
        normalized: list[list[int]] = []
        for point in corners:
            if not isinstance(point, (list, tuple)) or len(point) != 2:
                raise ValueError("each corner must be an integer coordinate pair")
            x, y = point
            if isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, int) or not isinstance(y, int):
                raise ValueError("each corner must be an integer coordinate pair")
            normalized.append([x, y])
        return normalized

    @staticmethod
    def _owned_task(session: Session, task_id: UUID, user_id: UUID) -> AnalysisTask | None:
        task = session.get(AnalysisTask, task_id)
        return (
            task
            if task is not None and task.user_id == user_id and task.deleted_at is None
            else None
        )

    def _require_owned_task(self, session: Session, task_id: UUID, user_id: UUID) -> AnalysisTask:
        task = self._owned_task(session, task_id, user_id)
        if task is None:
            raise ValueError("task was not found")
        return task
