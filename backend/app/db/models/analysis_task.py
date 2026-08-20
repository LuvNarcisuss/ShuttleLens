from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import DateTime, ForeignKey, Integer, JSON, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AnalysisTask(Base):
    __tablename__ = "analysis_tasks"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="created", nullable=False)
    name: Mapped[str] = mapped_column(String(160), default="未命名分析", nullable=False)
    stage: Mapped[str] = mapped_column(String(32), default="draft", nullable=False)
    progress: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    options_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    corners_json: Mapped[list[list[int]] | None] = mapped_column(JSON, nullable=True)
    input_video_path: Mapped[str] = mapped_column(String(1024), default="", nullable=False)
    template_path: Mapped[str] = mapped_column(String(1024), default="", nullable=False)
    cover_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    video_metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    calibration_frames_json: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    highlight_overrides_json: Mapped[dict[str, dict[str, Any]]] = mapped_column(
        JSON, default=dict, nullable=False
    )
    result_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    recovery_hint: Mapped[str | None] = mapped_column(Text, nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    source_task_id: Mapped[UUID | None] = mapped_column(ForeignKey("analysis_tasks.id"), nullable=True)
    player_position: Mapped[str | None] = mapped_column(String(8), nullable=True)
    match_result: Mapped[str | None] = mapped_column(String(8), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
