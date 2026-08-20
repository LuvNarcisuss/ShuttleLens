"""add user profile fields

Revision ID: 002_add_user_profile
Revises: 001_create_users
Create Date: 2026-07-21
"""

from alembic import op
import sqlalchemy as sa


revision = "002_add_user_profile"
down_revision = "001_create_users"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.add_column(
            sa.Column("nickname", sa.String(length=64), nullable=True)
        )
        batch_op.add_column(
            sa.Column("avatar_url", sa.String(length=2048), nullable=True)
        )


def downgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_column("avatar_url")
        batch_op.drop_column("nickname")
