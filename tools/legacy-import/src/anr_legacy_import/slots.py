"""Slots the pipeline already holds: the import leaves them, and everything under them, alone."""

from datetime import datetime
from typing import Any

import psycopg


def pipeline_holds(
    conn: psycopg.Connection[Any], newsroom_id: object, series_id: object, slot: datetime
) -> bool:
    """Whether the pipeline has a publication at the slot, in any language. Its assignment, story
    and renditions are then its own: an imported piece never writes over them (D172)."""
    row = conn.execute(
        "select exists (select from publications where newsroom_id = %s and series_id = %s"
        " and slot = %s and origin <> 'imported')",
        (newsroom_id, series_id, slot),
    ).fetchone()
    return bool(row and row[0])
