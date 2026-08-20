"""create analysis tasks

Revision ID: 003_create_analysis_tasks
Revises: 002_add_user_profile
Create Date: 2026-07-21
"""

from alembic import op
import sqlalchemy as sa


revision = "003_create_analysis_tasks"
down_revision = "002_add_user_profile"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "analysis_tasks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "status", sa.String(length=32), server_default=sa.text("'created'"), nullable=False
        ),
        sa.Column("progress", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("options_json", sa.JSON(), nullable=False),
        sa.Column("corners_json", sa.JSON(), nullable=True),
        sa.Column(
            "input_video_path", sa.String(length=1024), server_default=sa.text("''"), nullable=False
        ),
        sa.Column(
            "template_path", sa.String(length=1024), server_default=sa.text("''"), nullable=False
        ),
        sa.Column("result_json", sa.JSON(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_analysis_tasks_user_id", "analysis_tasks", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_analysis_tasks_user_id", table_name="analysis_tasks")
    op.drop_table("analysis_tasks")
