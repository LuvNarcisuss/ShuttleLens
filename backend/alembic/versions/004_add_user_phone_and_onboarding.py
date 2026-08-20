"""add user phone and onboarding fields

Revision ID: 004_user_phone_onboarding
Revises: 003_create_analysis_tasks
Create Date: 2026-07-29
"""

from alembic import op
import sqlalchemy as sa


revision = "004_user_phone_onboarding"
down_revision = "003_create_analysis_tasks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.add_column(sa.Column("phone_number_encrypted", sa.Text(), nullable=True))
        batch_op.add_column(sa.Column("phone_number_hash", sa.String(length=64), nullable=True))
        batch_op.add_column(sa.Column("phone_country_code", sa.String(length=8), nullable=True))
        batch_op.add_column(sa.Column("phone_verified_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(
            sa.Column("profile_completed_at", sa.DateTime(timezone=True), nullable=True)
        )
        batch_op.add_column(sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.create_index("ix_users_phone_number_hash", ["phone_number_hash"], unique=True)


def downgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_index("ix_users_phone_number_hash")
        batch_op.drop_column("last_login_at")
        batch_op.drop_column("profile_completed_at")
        batch_op.drop_column("phone_verified_at")
        batch_op.drop_column("phone_country_code")
        batch_op.drop_column("phone_number_hash")
        batch_op.drop_column("phone_number_encrypted")
