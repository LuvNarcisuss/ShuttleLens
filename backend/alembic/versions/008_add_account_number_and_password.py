"""Compatibility marker for the account credentials migration.

The account fields are created idempotently by the following lifecycle
migration.  Keeping this revision in the chain preserves databases that have
already recorded revision 008 while allowing Alembic to discover the graph.
"""

revision = "008_add_account_number_and_password"
down_revision = "007_add_player_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
