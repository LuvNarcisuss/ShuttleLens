from datetime import datetime
from typing import Any, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field, StrictInt, model_validator


class TaskOptions(BaseModel):
    pose_family: Literal["yolo-pose", "rtmpose", "rtmo"] = "yolo-pose"
    pose_mode: Literal["lightweight", "balanced", "performance"] = "balanced"
    language: Literal["zh", "en"] = "zh"
    audio: bool = True
    show_skeletons: bool = True
    show_player_trajectories: bool = True
    show_court_trajectory: bool = True
    show_shuttlecock_trajectory: bool = True
    show_player_stats: bool = True
    show_pose_roi: bool = True
    visualize_positions: bool = True
    yolo_pose_model: str = "weights/yolo11n-pose.pt"
    ball_model: str = "weights/yolo11s-ball.pt"


class CornersRequest(BaseModel):
    corners: list[tuple[StrictInt, StrictInt]] = Field(min_length=4, max_length=4)


class TaskResponse(BaseModel):
    id: UUID
    name: str = "未命名分析"
    status: Literal[
        "created",
        "uploading",
        "queued",
        "running",
        "publishing",
        "succeeded",
        "failed",
        "cancelled",
    ]
    stage: str = "draft"
    progress: int
    options: TaskOptions
    corners: list[tuple[int, int]] | None
    result: dict[str, Any] | None
    error_message: str | None
    error_code: str | None = None
    recovery_hint: str | None = None
    video_metadata: dict[str, Any] = Field(default_factory=dict)
    cover_available: bool = False
    source_task_id: UUID | None = None
    player_position: Literal["upper", "lower", "skip"] | None = None
    match_result: Literal["win", "loss", "draw"] | None = None
    created_at: datetime
    updated_at: datetime


class TaskListResponse(BaseModel):
    items: list[TaskResponse]
    total: int
    next_cursor: str | None = None


class TaskUpdateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=160)


class TaskRunRequest(BaseModel):
    player_position: Literal["upper", "lower", "skip"] | None = None
    match_result: Literal["win", "loss", "draw"] | None = None


class HighlightUpdateRequest(BaseModel):
    start_sec: float = Field(ge=0)
    end_sec: float = Field(gt=0)
    selected: bool = True
    title: str | None = Field(default=None, max_length=120)

    @model_validator(mode="after")
    def validate_range(self) -> "HighlightUpdateRequest":
        if self.end_sec <= self.start_sec:
            raise ValueError("end_sec must be greater than start_sec")
        return self


class ShareCreateRequest(BaseModel):
    resource_kind: Literal["report", "clip"]
    resource_key: str | None = Field(default=None, min_length=1, max_length=160)
    expires_in_hours: int = Field(default=24, ge=1, le=168)

    @model_validator(mode="after")
    def validate_resource(self) -> "ShareCreateRequest":
        if self.resource_kind == "clip" and not self.resource_key:
            raise ValueError("resource_key is required for clip shares")
        if self.resource_kind == "report" and self.resource_key:
            raise ValueError("resource_key is not allowed for report shares")
        return self


class CareerStatsResponse(BaseModel):
    total_matches: int  # 所有成功任务数
    matched_matches: int  # 排除跳过球员的场数
    total_duration_sec: float
    total_rallies: int
    avg_speed_mps: float
    max_speed_mps: float
    total_distance_m: float
    avg_court_coverage: float
    win_count: int
    loss_count: int
    draw_count: int
    win_rate: Optional[float] = None
    recent_matches: list[dict[str, Any]]
