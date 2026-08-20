"""add expiring share links

Revision ID: 006_share_links
Revises: 005_product_task_fields
Create Date: 2026-07-30
"""

from alembic import op
import sqlalchemy as sa


revision = "006_share_links"
down_revision = "005_product_task_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "share_links",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("task_id", sa.Uuid(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("resource_kind", sa.String(length=32), nullable=False),
        sa.Column("resource_key", sa.String(length=160), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["task_id"], ["analysis_tasks.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_share_links_created_by", "share_links", ["created_by"])
    op.create_index("ix_share_links_expires_at", "share_links", ["expires_at"])
    op.create_index("ix_share_links_task_id", "share_links", ["task_id"])
    op.create_index("ix_share_links_token_hash", "share_links", ["token_hash"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_share_links_token_hash", table_name="share_links")
    op.drop_index("ix_share_links_task_id", table_name="share_links")
    op.drop_index("ix_share_links_expires_at", table_name="share_links")
    op.drop_index("ix_share_links_created_by", table_name="share_links")
    op.drop_table("share_links")
