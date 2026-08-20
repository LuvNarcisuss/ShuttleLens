from __future__ import annotations

import base64
import hashlib
import json
import secrets
import subprocess
from datetime import UTC, datetime, timedelta
from enum import Enum
from functools import lru_cache
from pathlib import Path
from typing import Literal
from uuid import UUID
import statistics

from fastapi import APIRouter, Body, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse, Response
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.security import get_current_user, require_active_user
from app.db.models.analysis_task import AnalysisTask
from app.db.models.share_link import ShareLink
from app.db.models.user import User
from app.db.session import get_db
from app.schemas.analysis import (
    CareerStatsResponse,
    CornersRequest,
    HighlightUpdateRequest,
    ShareCreateRequest,
    TaskListResponse,
    TaskOptions,
    TaskResponse,
    TaskRunRequest,
    TaskUpdateRequest,
)
from app.services.analysis_tasks import AnalysisTaskService
from app.services.result_derivatives import clip_cache_filename, create_video_clip

router = APIRouter(prefix="/analysis", tags=["analysis"])

ALLOWED_VIDEO_TYPES = {"video/mp4", "video/quicktime", "video/webm", "video/x-msvideo"}
ALLOWED_TEMPLATE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/bmp"}
ResultKind = Literal[
    "video", "metadata", "detections", "visualization", "analytics", "highlights",
    "summary_csv", "report",
]
RESULT_MEDIA_TYPES = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".csv": "text/csv; charset=utf-8",
    ".html": "text/html; charset=utf-8",
}


@lru_cache
def get_analysis_task_service() -> AnalysisTaskService:
    return AnalysisTaskService()


def to_task_response(task: AnalysisTask) -> TaskResponse:
    stage_by_status = {
        "created": "draft",
        "uploading": "uploading",
        "queued": "queued",
        "running": "analysis",
        "publishing": "publishing",
        "succeeded": "completed",
        "failed": "failed",
        "cancelled": "cancelled",
    }
    return TaskResponse(
        id=task.id,
        name=task.name or "未命名分析",
        status=task.status,
        stage=task.stage or stage_by_status.get(task.status, "draft"),
        progress=task.progress,
        options=TaskOptions(**(task.options_json or {})),
        corners=task.corners_json,
        result=task.result_json,
        error_message=task.error_message,
        error_code=task.error_code,
        recovery_hint=task.recovery_hint,
        video_metadata=task.video_metadata_json or {},
        cover_available=bool(task.cover_path),
        source_task_id=task.source_task_id,
        player_position=task.player_position,
        match_result=task.match_result,
        created_at=task.created_at,
        updated_at=task.updated_at,
    )


def _owned_task(
    task_id: UUID,
    user: User,
    service: AnalysisTaskService,
) -> AnalysisTask:
    task = service.get_task(task_id, user.id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Analysis task not found")
    return task


def _conflict(error: ValueError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error))


async def _save_upload(
    task_id: UUID,
    upload_type: Literal["video", "template"],
    file: UploadFile,
    user: User,
    service: AnalysisTaskService,
    settings: Settings,
) -> TaskResponse:
    _owned_task(task_id, user, service)
    allowed_types = ALLOWED_VIDEO_TYPES if upload_type == "video" else ALLOWED_TEMPLATE_TYPES
    if file.content_type not in allowed_types:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"Unsupported {upload_type} MIME type",
        )
    if not file.filename or Path(file.filename).name in {"", ".", ".."}:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Upload filename is required",
        )
    content = await file.read()
    max_bytes = (
        settings.max_video_upload_bytes
        if upload_type == "video"
        else settings.max_template_upload_bytes
    )
    if not content:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Upload file must not be empty",
        )
    if len(content) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Upload exceeds the configured size limit",
        )
    try:
        task = service.save_upload(task_id, user.id, upload_type, file.filename, content)
    except ValueError as error:
        raise _conflict(error) from error
    return to_task_response(task)


@router.post("/tasks", response_model=TaskResponse, status_code=status.HTTP_201_CREATED)
def create_task(
    options: TaskOptions,
    user: User = Depends(require_active_user),
    service: AnalysisTaskService = Depends(get_analysis_task_service),
) -> TaskResponse:
    return to_task_response(service.create_draft(user.id, options))


@router.post("/tasks/{task_id}/uploads/video", response_model=TaskResponse)
async def upload_video(
    task_id: UUID,
    file: UploadFile = File(...),
    user: User = Depends(require_active_user),
    service: AnalysisTaskService = Depends(get_analysis_task_service),
    settings: Settings = Depends(get_settings),
) -> TaskResponse:
    return await _save_upload(task_id, "video", file, user, service, settings)


@router.post("/tasks/{task_id}/uploads/template", response_model=TaskResponse)
async def upload_template(
    task_id: UUID,
    file: UploadFile = File(...),
    user: User = Depends(require_active_user),
    service: AnalysisTaskService = Depends(get_analysis_task_service),
    settings: Settings = Depends(get_settings),
) -> TaskResponse:
    return await _save_upload(task_id, "template", file, user, service, settings)


@router.post("/tasks/{task_id}/detect-court")
def detect_court(
    task_id: UUID,
    user: User = Depends(require_active_user),
    service: AnalysisTaskService = Depends(get_analysis_task_service),
) -> dict[str, object]:
    task = _owned_task(task_id, user, service)
    if not task.input_video_path or not task.template_path:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Video and template uploads are required before corner detection",
        )
    try:
        corners = service.detect_template_corners(task_id, user.id)
    except ValueError as error:
        raise _conflict(error) from error
    return {"corners": corners, "preview": {"kind": "template"}}


@router.put("/tasks/{task_id}/corners", response_model=TaskResponse)
def save_corners(
    task_id: UUID,
    request: CornersRequest,
    user: User = Depends(require_active_user),
    service: AnalysisTaskService = Depends(get_analysis_task_service),
) -> TaskResponse:
    _owned_task(task_id, user, service)
    try:
        task = service.save_corners(task_id, user.id, request.corners)
    except ValueError as error:
        raise _conflict(error) from error
    return to_task_response(task)


@router.post("/tasks/{task_id}/run", response_model=TaskResponse)
def run_task(
    task_id: UUID,
    request: TaskRunRequest = Body(default_factory=TaskRunRequest),
    user: User = Depends(require_active_user),
    service: AnalysisTaskService = Depends(get_analysis_task_service),
    db: Session = Depends(get_db),
) -> TaskResponse:
    task = _owned_task(task_id, user, service)
    try:
        # 保存球员选择和比赛结果到数据库
        db_task = db.get(AnalysisTask, task_id)
        if db_task:
            db_task.player_position = request.player_position
            if request.player_position and request.player_position != "skip":
                db_task.match_result = request.match_result
            db.commit()
            db.refresh(db_task)
        # 然后入队分析
        task = service.enqueue(task_id, user.id)
    except ValueError as error:
        raise _conflict(error) from error
    return to_task_response(task)


@router.get("/tasks", response_model=TaskListResponse)
def list_tasks(
    task_status: Literal[
        "created",
        "uploading",
        "queued",
        "running",
        "publishing",
        "succeeded",
        "failed",
        "cancelled",
    ]
    | None = Query(default=None, alias="status"),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=50),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TaskListResponse:
    filters = [AnalysisTask.user_id == user.id, AnalysisTask.deleted_at.is_(None)]
    if task_status:
        filters.append(AnalysisTask.status == task_status)
    if cursor:
        try:
            padded = cursor + "=" * (-len(cursor) % 4)
            payload = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
            cursor_created_at = datetime.fromisoformat(payload["created_at"])
            cursor_id = UUID(payload["id"])
        except (ValueError, KeyError, TypeError, json.JSONDecodeError):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Invalid task cursor",
            ) from None
        filters.append(
            or_(
                AnalysisTask.created_at < cursor_created_at,
                and_(
                    AnalysisTask.created_at == cursor_created_at,
                    AnalysisTask.id < cursor_id,
                ),
            )
        )
    tasks = db.scalars(
        select(AnalysisTask)
        .where(*filters)
        .order_by(AnalysisTask.created_at.desc(), AnalysisTask.id.desc())
        .limit(limit + 1)
    ).all()
    has_next = len(tasks) > limit
    page = tasks[:limit]
    next_cursor = None
    if has_next and page:
        last = page[-1]
        raw = json.dumps({"created_at": last.created_at.isoformat(), "id": str(last.id)})
        next_cursor = base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")
    total_filters = [AnalysisTask.user_id == user.id, AnalysisTask.deleted_at.is_(None)]
    if task_status:
        total_filters.append(AnalysisTask.status == task_status)
    total = db.scalar(select(func.count()).select_from(AnalysisTask).where(*total_filters)) or 0
    return TaskListResponse(
        items=[to_task_response(task) for task in page],
        total=total,
        next_cursor=next_cursor,
    )


@router.patch("/tasks/{task_id}", response_model=TaskResponse)
def rename_task(
    task_id: UUID,
    request: TaskUpdateRequest,
    user: User = Depends(require_active_user),
    service: AnalysisTaskService = Depends(get_analysis_task_service),
) -> TaskResponse:
    _owned_task(task_id, user, service)
    try:
        return to_task_response(service.rename(task_id, user.id, request.name))
    except ValueError as error:
        raise _conflict(error) from error


@router.post("/tasks/{task_id}/cancel", response_model=TaskResponse)
def cancel_task(
    task_id: UUID,
    user: User = Depends(require_active_user),
    service: AnalysisTaskService = Depends(get_analysis_task_service),
) -> TaskResponse:
    _owned_task(task_id, user, service)
    try:
        return to_task_response(service.cancel(task_id, user.id))
    except ValueError as error:
        raise _conflict(error) from error


@router.post("/tasks/{task_id}/retry", response_model=TaskResponse)
def retry_task(
    task_id: UUID,
    user: User = Depends(require_active_user),
    service: AnalysisTaskService = Depends(get_analysis_task_service),
) -> TaskResponse:
    _owned_task(task_id, user, service)
    try:
        return to_task_response(service.retry(task_id, user.id))
    except ValueError as error:
        raise _conflict(error) from error


@router.post("/tasks/{task_id}/reanalyze", response_model=TaskResponse)
def reanalyze_task(
    task_id: UUID,
    user: User = Depends(require_active_user),
    service: AnalysisTaskService = Depends(get_analysis_task_service),
) -> TaskResponse:
    _owned_task(task_id, user, service)
    try:
        return to_task_response(service.reanalyze(task_id, user.id))
    except ValueError as error:
        raise _conflict(error) from error


@router.delete("/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_task(
    task_id: UUID,
    user: User = Depends(require_active_user),
    service: AnalysisTaskService = Depends(get_analysis_task_service),
) -> Response:
    _owned_task(task_id, user, service)
    try:
        service.soft_delete(task_id, user.id)
    except ValueError as error:
        raise _conflict(error) from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/tasks/{task_id}", response_model=TaskResponse)
def get_task(
    task_id: UUID,
    user: User = Depends(get_current_user),
    service: AnalysisTaskService = Depends(get_analysis_task_service),
) -> TaskResponse:
    return to_task_response(_owned_task(task_id, user, service))


@router.get("/tasks/{task_id}/calibration-frames")
def list_calibration_frames(
    task_id: UUID,
    user: User = Depends(get_current_user),
    service: AnalysisTaskService = Depends(get_analysis_task_service),
) -> dict[str, list[dict[str, int | float]]]:
    task = _owned_task(task_id, user, service)
    items = []
    for index, frame in enumerate(task.calibration_frames_json or []):
        items.append(
            {
                "index": index,
                "timestamp_sec": float(frame.get("timestamp_sec") or 0),
                "width": int(frame.get("width") or 0),
                "height": int(frame.get("height") or 0),
            }
        )
    return {"items": items}


@router.get("/tasks/{task_id}/files/calibration", response_class=FileResponse)
def get_calibration_frame(
    task_id: UUID,
    index: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    service: AnalysisTaskService = Depends(get_analysis_task_service),
    settings: Settings = Depends(get_settings),
) -> FileResponse:
    task = _owned_task(task_id, user, service)
    frames = task.calibration_frames_json or []
    if index >= len(frames):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Calibration frame not found")
    stored_path = frames[index].get("path")
    if not isinstance(stored_path, str) or not stored_path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Calibration frame not found")
    root = Path(settings.analysis_storage_dir).resolve()
    path = (root / stored_path).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Calibration frame not found") from None
    if not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Calibration frame not found")
    return FileResponse(
        path,
        media_type=RESULT_MEDIA_TYPES.get(path.suffix.lower(), "image/jpeg"),
        filename=f"calibration-{task_id}-{index + 1}{path.suffix.lower() or '.jpg'}",
        headers={"Cache-Control": "private, no-store"},
    )


def _result_path(
    task: AnalysisTask,
    kind: ResultKind,
    index: int | None,
    storage_dir: str,
) -> Path:
    if task.status != "succeeded":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Result files are available only for succeeded tasks",
        )
    result = task.result_json or {}
    if kind == "visualization":
        if index is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Visualization index is required",
            )
        visualizations = result.get("visualizations")
        if not isinstance(visualizations, list) or index >= len(visualizations):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Result file not found")
        stored_path = visualizations[index]
    else:
        stored_path = result.get(kind)
    if not isinstance(stored_path, str) or not stored_path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Result file not found")

    root = Path(storage_dir).resolve()
    path = (root / stored_path).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Result file not found") from None
    if not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Result file not found")
    return path


def _read_result_json(
    task: AnalysisTask,
    kind: Literal["analytics", "highlights"],
    storage_dir: str,
) -> dict[str, object]:
    path = _result_path(task, kind, None, storage_dir)
    if path.stat().st_size > 20 * 1024 * 1024:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Result JSON is too large")
    try:
        with path.open(encoding="utf-8") as source:
            payload = json.load(source)
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Result JSON is invalid") from None
    if not isinstance(payload, dict):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Result JSON is invalid")
    return payload


def _merged_highlights(task: AnalysisTask, payload: dict[str, object]) -> dict[str, object]:
    overrides = task.highlight_overrides_json or {}
    items = payload.get("items")
    if not isinstance(items, list):
        return payload
    merged_items = []
    for raw_item in items:
        if not isinstance(raw_item, dict):
            continue
        item = dict(raw_item)
        override = overrides.get(str(item.get("id")))
        if isinstance(override, dict):
            item.update(override)
            item["source"] = "user_edited"
        merged_items.append(item)
    return {**payload, "items": merged_items}


def _task_video_duration(task: AnalysisTask, storage_dir: str) -> float | None:
    metadata_duration = (task.video_metadata_json or {}).get("duration_sec")
    if isinstance(metadata_duration, (int, float)) and metadata_duration > 0:
        return float(metadata_duration)
    try:
        analytics = _read_result_json(task, "analytics", storage_dir)
        match = analytics.get("match")
        duration_metric = match.get("duration_sec") if isinstance(match, dict) else None
        duration = duration_metric.get("value") if isinstance(duration_metric, dict) else None
        if isinstance(duration, (int, float)) and duration > 0:
            return float(duration)
    except HTTPException:
        pass
    try:
        metadata_path = _result_path(task, "metadata", None, storage_dir)
        with metadata_path.open(encoding="utf-8") as source:
            metadata = json.load(source)
        duration = (metadata.get("video") or {}).get("duration_sec") if isinstance(metadata, dict) else None
        if isinstance(duration, (int, float)) and duration > 0:
            return float(duration)
    except (HTTPException, OSError, UnicodeError, json.JSONDecodeError):
        pass
    return None


@router.get("/tasks/{task_id}/analytics")
def get_task_analytics(
    task_id: UUID,
    user: User = Depends(get_current_user),
    service: AnalysisTaskService = Depends(get_analysis_task_service),
    settings: Settings = Depends(get_settings),
) -> dict[str, object]:
    task = _owned_task(task_id, user, service)
    return _read_result_json(task, "analytics", settings.analysis_storage_dir)


@router.get("/tasks/{task_id}/highlights")
def get_task_highlights(
    task_id: UUID,
    user: User = Depends(get_current_user),
    service: AnalysisTaskService = Depends(get_analysis_task_service),
    settings: Settings = Depends(get_settings),
) -> dict[str, object]:
    task = _owned_task(task_id, user, service)
    payload = _read_result_json(task, "highlights", settings.analysis_storage_dir)
    return _merged_highlights(task, payload)


@router.put("/tasks/{task_id}/highlights/{highlight_id}")
def update_task_highlight(
    task_id: UUID,
    highlight_id: str,
    request: HighlightUpdateRequest,
    user: User = Depends(require_active_user),
    service: AnalysisTaskService = Depends(get_analysis_task_service),
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    task = _owned_task(task_id, user, service)
    payload = _read_result_json(task, "highlights", settings.analysis_storage_dir)
    items = payload.get("items")
    if not isinstance(items, list) or not any(
        isinstance(item, dict) and item.get("id") == highlight_id for item in items
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Highlight not found")
    video_duration = _task_video_duration(task, settings.analysis_storage_dir)
    if video_duration is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Video duration is unavailable; highlight range cannot be edited safely",
        )
    if request.end_sec > video_duration:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Highlight range exceeds the video duration",
        )
    overrides = dict(task.highlight_overrides_json or {})
    overrides[highlight_id] = request.model_dump(exclude_none=True)
    task.highlight_overrides_json = overrides
    db.merge(task)
    db.commit()
    return _merged_highlights(task, payload)


def _clip_path(task: AnalysisTask, resource_key: str, storage_dir: str) -> Path:
    clips = (task.result_json or {}).get("clips")
    stored_path = clips.get(resource_key) if isinstance(clips, dict) else None
    if not isinstance(stored_path, str) or not stored_path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Clip not found")
    root = Path(storage_dir).resolve()
    path = (root / stored_path).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Clip not found") from None
    if not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Clip not found")
    return path


@router.post("/tasks/{task_id}/highlights/{highlight_id}/clip", status_code=status.HTTP_201_CREATED)
def create_highlight_clip(
    task_id: UUID,
    highlight_id: str,
    user: User = Depends(require_active_user),
    service: AnalysisTaskService = Depends(get_analysis_task_service),
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    task = _owned_task(task_id, user, service)
    highlights = _merged_highlights(
        task,
        _read_result_json(task, "highlights", settings.analysis_storage_dir),
    ).get("items")
    highlight = next(
        (
            item for item in highlights or []
            if isinstance(item, dict) and item.get("id") == highlight_id
        ),
        None,
    )
    if highlight is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Highlight not found")
    source = _result_path(task, "video", None, settings.analysis_storage_dir)
    start_sec = float(highlight.get("start_sec") or 0)
    end_sec = float(highlight.get("end_sec") or 0)
    video_duration = _task_video_duration(task, settings.analysis_storage_dir)
    if video_duration is None or end_sec > video_duration:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Highlight range cannot be verified against the video duration",
        )
    safe_name = clip_cache_filename(highlight_id, start_sec, end_sec)
    destination = source.parent / "clips" / f"{safe_name}.mp4"
    try:
        created = create_video_clip(
            source,
            destination,
            start_sec,
            end_sec,
            source_duration_sec=video_duration,
        )
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"Clip generation failed: {type(error).__name__}",
        ) from error
    root = Path(settings.analysis_storage_dir).resolve()
    result = dict(task.result_json or {})
    clips = dict(result.get("clips") or {})
    clips[highlight_id] = created.resolve().relative_to(root).as_posix()
    result["clips"] = clips
    task.result_json = result
    db.merge(task)
    db.commit()
    return {"resource_key": highlight_id, "file_path": f"/api/analysis/tasks/{task_id}/files/clips/{highlight_id}"}


@router.get("/tasks/{task_id}/files/clips/{highlight_id}", response_class=FileResponse)
def get_highlight_clip(
    task_id: UUID,
    highlight_id: str,
    user: User = Depends(get_current_user),
    service: AnalysisTaskService = Depends(get_analysis_task_service),
    settings: Settings = Depends(get_settings),
) -> FileResponse:
    task = _owned_task(task_id, user, service)
    path = _clip_path(task, highlight_id, settings.analysis_storage_dir)
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=f"highlight-{task_id}.mp4",
        headers={"Cache-Control": "private, no-store"},
    )


@router.post("/tasks/{task_id}/shares", status_code=status.HTTP_201_CREATED)
def create_share_link(
    task_id: UUID,
    request: ShareCreateRequest,
    user: User = Depends(require_active_user),
    service: AnalysisTaskService = Depends(get_analysis_task_service),
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    task = _owned_task(task_id, user, service)
    if request.resource_kind == "report":
        _result_path(task, "report", None, settings.analysis_storage_dir)
    else:
        _clip_path(task, request.resource_key or "", settings.analysis_storage_dir)
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(UTC) + timedelta(hours=request.expires_in_hours)
    share = ShareLink(
        task_id=task.id,
        created_by=user.id,
        token_hash=hashlib.sha256(token.encode("utf-8")).hexdigest(),
        resource_kind=request.resource_kind,
        resource_key=request.resource_key,
        expires_at=expires_at,
    )
    db.add(share)
    db.commit()
    db.refresh(share)
    return {
        "id": share.id,
        "share_path": f"/api/analysis/shares/{token}",
        "resource_kind": share.resource_kind,
        "expires_at": share.expires_at,
    }


@router.delete("/tasks/{task_id}/shares/{share_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_share_link(
    task_id: UUID,
    share_id: UUID,
    user: User = Depends(require_active_user),
    service: AnalysisTaskService = Depends(get_analysis_task_service),
    db: Session = Depends(get_db),
) -> Response:
    _owned_task(task_id, user, service)
    share = db.get(ShareLink, share_id)
    if share is None or share.task_id != task_id or share.created_by != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share link not found")
    share.revoked_at = datetime.now(UTC)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/shares/{token}", response_class=FileResponse)
def access_shared_resource(
    token: str,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db),
) -> FileResponse:
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    share = db.scalar(select(ShareLink).where(ShareLink.token_hash == token_hash))
    if share is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share link not found")
    expires_at = share.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    if share.revoked_at is not None or expires_at <= datetime.now(UTC):
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Share link expired or revoked")
    task = db.get(AnalysisTask, share.task_id)
    if task is None or task.deleted_at is not None or task.status != "succeeded":
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Shared resource is unavailable")
    if share.resource_kind == "report":
        path = _result_path(task, "report", None, settings.analysis_storage_dir)
        media_type = "text/html; charset=utf-8"
        filename = f"analysis-{task.id}-report.html"
    elif share.resource_kind == "clip" and share.resource_key:
        path = _clip_path(task, share.resource_key, settings.analysis_storage_dir)
        media_type = "video/mp4"
        filename = f"analysis-{task.id}-highlight.mp4"
    else:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shared resource not found")
    return FileResponse(
        path,
        media_type=media_type,
        filename=filename,
        headers={"Cache-Control": "private, no-store"},
    )


@router.get("/tasks/{task_id}/files/{kind}", response_class=FileResponse)
def get_task_file(
    task_id: UUID,
    kind: ResultKind,
    index: int | None = Query(default=None, ge=0),
    user: User = Depends(get_current_user),
    service: AnalysisTaskService = Depends(get_analysis_task_service),
    settings: Settings = Depends(get_settings),
) -> FileResponse:
    task = _owned_task(task_id, user, service)
    path = _result_path(task, kind, index, settings.analysis_storage_dir)
    suffix = path.suffix.lower()
    if kind == "video":
        filename = f"analysis-{task_id}{suffix or '.mp4'}"
    elif kind == "visualization":
        filename = f"analysis-{task_id}-chart-{(index or 0) + 1}{suffix or '.png'}"
    else:
        filename = f"analysis-{task_id}-{kind}{suffix or '.json'}"
    return FileResponse(
        path,
        media_type=RESULT_MEDIA_TYPES.get(suffix, "application/octet-stream"),
        filename=filename,
        headers={"Cache-Control": "private, no-store"},
    )


class DateRange(str, Enum):
    week = "week"
    month = "month"
    three_months = "three_months"
    six_months = "six_months"
    year = "year"
    all = "all"


@router.get("/career/stats", response_model=CareerStatsResponse)
def get_career_stats(
    date_range: DateRange = DateRange.all,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> CareerStatsResponse:
    """获取用户羽球生涯汇总统计，支持时间范围筛选"""

    # 构建时间过滤条件
    now = datetime.now(UTC)
    if date_range == DateRange.week:
        start_date = now - timedelta(weeks=1)
    elif date_range == DateRange.month:
        start_date = now - timedelta(days=30)
    elif date_range == DateRange.three_months:
        start_date = now - timedelta(days=90)
    elif date_range == DateRange.six_months:
        start_date = now - timedelta(days=180)
    elif date_range == DateRange.year:
        start_date = now - timedelta(days=365)
    else:
        start_date = None

    # 查询所有成功的分析任务（必须选择了球员且不是跳过）
    query = db.query(AnalysisTask).filter(
        AnalysisTask.user_id == current_user.id,
        AnalysisTask.status == "succeeded",
        AnalysisTask.deleted_at.is_(None),
        AnalysisTask.player_position.isnot(None),
        AnalysisTask.player_position != "skip",
    )

    if start_date:
        query = query.filter(AnalysisTask.created_at >= start_date)

    tasks = query.order_by(
        AnalysisTask.created_at.desc(),
        AnalysisTask.id.desc(),
    ).all()

    if not tasks:
        return CareerStatsResponse(
            total_matches=0,
            matched_matches=0,
            total_duration_sec=0,
            total_rallies=0,
            avg_speed_mps=0,
            max_speed_mps=0,
            total_distance_m=0,
            avg_court_coverage=0,
            win_count=0,
            loss_count=0,
            draw_count=0,
            win_rate=None,
            recent_matches=[],
        )

    # 汇总统计
    total_duration = 0.0
    total_rallies = 0
    average_speeds = []
    maximum_speeds = []
    distances = []
    coverages = []
    win_count = 0
    loss_count = 0
    draw_count = 0
    matched_count = 0  # 排除跳过球员的场数

    for task in tasks:
        # 计算 matched_count（有球员选择且不是 skip 的场次）
        if task.player_position and task.player_position != 'skip':
            matched_count += 1

        # 统计胜负（所有有球员选择的任务都统计）
        if task.match_result == "win":
            win_count += 1
        elif task.match_result == "loss":
            loss_count += 1
        elif task.match_result == "draw":
            draw_count += 1

        try:
            result = _read_result_json(task, "analytics", settings.analysis_storage_dir)
        except HTTPException:
            continue

        # 获取用户选择的球员数据
        player_data = result.get("players", {}).get(task.player_position, {})

        match_data = result.get("match", {})
        if isinstance(match_data, dict):
            duration_metric = match_data.get("duration_sec")
            if isinstance(duration_metric, dict):
                total_duration += float(duration_metric.get("value", 0))
            rally_metric = match_data.get("rally_count")
            if isinstance(rally_metric, dict):
                total_rallies += int(rally_metric.get("value", 0))

        if isinstance(player_data, dict):
            speed_metric = player_data.get("average_speed_mps")
            if isinstance(speed_metric, dict) and "value" in speed_metric:
                average_speeds.append(float(speed_metric["value"]))
            max_speed_metric = player_data.get("maximum_speed_mps")
            if isinstance(max_speed_metric, dict) and "value" in max_speed_metric:
                maximum_speeds.append(float(max_speed_metric["value"]))
            dist_metric = player_data.get("distance_m")
            if isinstance(dist_metric, dict) and "value" in dist_metric:
                distances.append(float(dist_metric["value"]))
            coverage_metric = player_data.get("court_coverage_ratio")
            if isinstance(coverage_metric, dict) and "value" in coverage_metric:
                coverages.append(float(coverage_metric["value"]))

    # 计算胜率（只统计有胜负记录的比赛）
    total_decided = win_count + loss_count
    win_rate = win_count / total_decided if total_decided > 0 else None

    return CareerStatsResponse(
        total_matches=len(tasks),
        matched_matches=matched_count,
        total_duration_sec=total_duration,
        total_rallies=total_rallies,
        avg_speed_mps=statistics.mean(average_speeds) if average_speeds else 0,
        max_speed_mps=max(maximum_speeds) if maximum_speeds else 0,
        total_distance_m=sum(distances),
        avg_court_coverage=statistics.mean(coverages) if coverages else 0,
        win_count=win_count,
        loss_count=loss_count,
        draw_count=draw_count,
        win_rate=win_rate,
        recent_matches=[
            {
                "task_id": str(task.id),
                "name": task.name,
                "created_at": task.created_at.isoformat(),
                "match_result": task.match_result,
            }
            for task in tasks[:10]  # 最近10场比赛
        ],
    )
