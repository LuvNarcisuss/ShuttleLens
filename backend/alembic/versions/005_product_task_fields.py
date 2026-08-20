"""add product task center fields

Revision ID: 005_product_task_fields
Revises: 004_user_phone_onboarding
Create Date: 2026-07-30
"""

from alembic import context, op
import sqlalchemy as sa


revision = "005_product_task_fields"
down_revision = "004_user_phone_onboarding"
branch_labels = None
depends_on = None


JSON_COLUMNS = (
    "video_metadata_json",
    "calibration_frames_json",
    "highlight_overrides_json",
)


def _existing_schema() -> tuple[set[str], set[str], set[str]]:
    if context.is_offline_mode():
        return set(), set(), set()
    inspector = sa.inspect(op.get_bind())
    columns = {item["name"] for item in inspector.get_columns("analysis_tasks")}
    indexes = {item["name"] for item in inspector.get_indexes("analysis_tasks")}
    foreign_keys = {
        item["name"]
        for item in inspector.get_foreign_keys("analysis_tasks")
        if item.get("name")
    }
    return columns, indexes, foreign_keys


def _add_missing_columns(existing: set[str]) -> None:
    columns = (
        sa.Column(
            "name",
            sa.String(length=160),
            nullable=False,
            server_default="未命名分析",
        ),
        sa.Column("cover_path", sa.String(length=1024), nullable=True),
        sa.Column("video_metadata_json", sa.JSON(), nullable=True),
        sa.Column("calibration_frames_json", sa.JSON(), nullable=True),
        sa.Column("highlight_overrides_json", sa.JSON(), nullable=True),
        sa.Column(
            "stage", sa.String(length=32), nullable=False, server_default="draft"
        ),
        sa.Column("error_code", sa.String(length=64), nullable=True),
        sa.Column("recovery_hint", sa.Text(), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("source_task_id", sa.Uuid(), nullable=True),
    )
    for column in columns:
        if column.name not in existing:
            op.add_column("analysis_tasks", column)


def _backfill_json_columns() -> None:
    values = {
        "video_metadata_json": "{}",
        "calibration_frames_json": "[]",
        "highlight_overrides_json": "{}",
    }
    for column_name, value in values.items():
        op.execute(
            sa.text(
                f"UPDATE analysis_tasks SET {column_name} = '{value}' "
                f"WHERE {column_name} IS NULL"
            )
        )


def _make_json_columns_required() -> None:
    dialect = op.get_bind().dialect.name
    if dialect == "sqlite" and not context.is_offline_mode():
        with op.batch_alter_table("analysis_tasks") as batch_op:
            for column_name in JSON_COLUMNS:
                batch_op.alter_column(
                    column_name,
                    existing_type=sa.JSON(),
                    nullable=False,
                )
        return
    for column_name in JSON_COLUMNS:
        op.alter_column(
            "analysis_tasks",
            column_name,
            existing_type=sa.JSON(),
            nullable=False,
        )


def upgrade() -> None:
    columns, indexes, foreign_keys = _existing_schema()
    _add_missing_columns(columns)
    _backfill_json_columns()
    _make_json_columns_required()

    foreign_key_name = "fk_analysis_tasks_source_task_id"
    if foreign_key_name not in foreign_keys:
        if op.get_bind().dialect.name == "sqlite" and not context.is_offline_mode():
            with op.batch_alter_table("analysis_tasks") as batch_op:
                batch_op.create_foreign_key(
                    foreign_key_name,
                    "analysis_tasks",
                    ["source_task_id"],
                    ["id"],
                )
        else:
            op.create_foreign_key(
                foreign_key_name,
                "analysis_tasks",
                "analysis_tasks",
                ["source_task_id"],
                ["id"],
            )

    index_name = "ix_analysis_tasks_deleted_at"
    if index_name not in indexes:
        op.create_index(index_name, "analysis_tasks", ["deleted_at"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("analysis_tasks") as batch_op:
        batch_op.drop_index("ix_analysis_tasks_deleted_at")
        batch_op.drop_constraint(
            "fk_analysis_tasks_source_task_id", type_="foreignkey"
        )
        batch_op.drop_column("source_task_id")
        batch_op.drop_column("deleted_at")
        batch_op.drop_column("recovery_hint")
        batch_op.drop_column("error_code")
        batch_op.drop_column("stage")
        batch_op.drop_column("video_metadata_json")
        batch_op.drop_column("highlight_overrides_json")
        batch_op.drop_column("calibration_frames_json")
        batch_op.drop_column("cover_path")
        batch_op.drop_column("name")
