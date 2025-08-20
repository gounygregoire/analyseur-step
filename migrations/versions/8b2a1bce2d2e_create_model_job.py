"""create model_jobs table

Revision ID: 8b2a1bce2d2e
Revises: 1197ac9c0998
Create Date: 2025-07-31 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '8b2a1bce2d2e'
down_revision: Union[str, Sequence[str], None] = '1197ac9c0998'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'model_jobs',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('sha256', sa.String(length=64), nullable=False, unique=True),
        sa.Column('original_filename', sa.String(length=255), nullable=False),
        sa.Column('size_bytes', sa.Integer(), nullable=False),
        sa.Column('mime', sa.String(length=50), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('user_id', sa.String(length=36), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('preview_url', sa.String(length=255), nullable=True),
        sa.Column('final_url', sa.String(length=255), nullable=True),
        sa.Column('dfm_json_url', sa.String(length=255), nullable=True),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('error_message', sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table('model_jobs')
