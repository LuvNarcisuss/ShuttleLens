"""add account settings lifecycle fields

Revision ID: 009_account_settings_lifecycle
Revises: 007_add_player_fields
Create Date: 2026-08-12
"""

from alembic import op
import sqlalchemy as sa


revision = "009_account_settings_lifecycle"
down_revision = "008_add_account_number_and_password"
branch_labels = None
depends_on = None


def _columns() -> set[str]:
    return {item["name"] for item in sa.inspect(op.get_bind()).get_columns("users")}


def _indexes() -> set[str]:
    return {item["name"] for item in sa.inspect(op.get_bind()).get_indexes("users")}


def _add_missing_columns(existing: set[str]) -> None:
    columns = (
        sa.Column("account_number", sa.String(length=8), nullable=True),
        sa.Column("password_hash", sa.String(length=255), nullable=True),
        sa.Column("wechat_unlinked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deactivated_at", sa.DateTime(timezone=True), nullable=True),
    )
    for column in columns:
        if column.name not in existing:
            op.add_column("users", column)


def _backfill_account_numbers() -> None:
    connection = op.get_bind()
    rows = connection.execute(
        sa.text("SELECT id, account_number FROM users ORDER BY id")
    ).fetchall()
    used = {str(row.account_number) for row in rows if row.account_number is not None}
    next_number = 10_000_000
    for row in rows:
        if row.account_number is not None:
            continue
        while str(next_number) in used:
            next_number += 1
        account_number = f"{next_number:08d}"
        connection.execute(
            sa.text("UPDATE users SET account_number = :account_number WHERE id = :user_id"),
            {"account_number": account_number, "user_id": row.id},
        )
        used.add(account_number)
        next_number += 1


def _make_account_number_required() -> None:
    if op.get_bind().dialect.name == "sqlite":
        with op.batch_alter_table("users") as batch_op:
            batch_op.alter_column(
                "account_number",
                existing_type=sa.String(length=8),
                nullable=False,
            )
    else:
        op.alter_column(
            "users",
            "account_number",
            existing_type=sa.String(length=8),
            nullable=False,
        )


def upgrade() -> None:
    existing = _columns()
    _add_missing_columns(existing)
    _backfill_account_numbers()
    _make_account_number_required()
    if "ix_users_account_number" not in _indexes():
        op.create_index("ix_users_account_number", "users", ["account_number"], unique=True)


def downgrade() -> None:
    indexes = _indexes()
    if "ix_users_account_number" in indexes:
        op.drop_index("ix_users_account_number", table_name="users")
    with op.batch_alter_table("users") as batch_op:
        for column in ("deactivated_at", "wechat_unlinked_at", "password_hash", "account_number"):
            batch_op.drop_column(column)
