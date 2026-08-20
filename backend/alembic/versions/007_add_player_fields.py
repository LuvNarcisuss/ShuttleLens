"""add player_position and match_result

Revision ID: 007_add_player_fields
Revises: 006_share_links
Create Date: 2026-08-05
"""

from alembic import op
import sqlalchemy as sa


revision = "007_add_player_fields"
down_revision = "006_share_links"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "analysis_tasks",
        sa.Column("player_position", sa.String(length=8), nullable=True)
    )
    op.add_column(
        "analysis_tasks",
        sa.Column("match_result", sa.String(length=8), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("analysis_tasks", "match_result")
    op.drop_column("analysis_tasks", "player_position")
