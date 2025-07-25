"""add xkt_filename

Revision ID: 1197ac9c0998
Revises: 
Create Date: 2025-07-25 09:32:51.214509

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '1197ac9c0998'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema by adding xkt_filename column."""
    op.add_column('conversion_jobs', sa.Column('xkt_filename', sa.String(length=255), nullable=True))


def downgrade() -> None:
    """Remove xkt_filename column."""
    op.drop_column('conversion_jobs', 'xkt_filename')
