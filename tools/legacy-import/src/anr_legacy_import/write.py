"""Writes imported entries in one transaction, as the system role, in the newsroom's setting."""

import psycopg
from psycopg.types.json import Jsonb

from .mapping import Entry

UPSERT = """
insert into reference_entries
  (newsroom_id, kind, slug, title, title_language, date, date_status, facts, body,
   origin, legacy_id, listed, search_text)
values (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'imported', %s, %s, %s)
on conflict (newsroom_id, legacy_id) do update set
  kind = excluded.kind, slug = excluded.slug, title = excluded.title,
  title_language = excluded.title_language, date = excluded.date,
  date_status = excluded.date_status, facts = excluded.facts, body = excluded.body,
  listed = excluded.listed, search_text = excluded.search_text, updated_at = now()
returning (xmax = 0) as inserted
"""


def write(url: str, newsroom: str, entries: list[Entry]) -> tuple[int, int]:
    inserted = updated = 0
    with psycopg.connect(url) as conn, conn.transaction():
        row = conn.execute(
            "select id from newsrooms where slug = %s and removed_at is null", (newsroom,)
        ).fetchone()
        if not row:
            raise SystemExit(f"no newsroom {newsroom!r}; run pnpm config:sync")
        newsroom_id = row[0]
        conn.execute("select set_config('anr.newsroom_id', %s, true)", (str(newsroom_id),))
        for e in entries:
            res = conn.execute(
                UPSERT,
                (
                    newsroom_id,
                    e.kind,
                    e.slug,
                    e.title,
                    e.title_language,
                    e.date,
                    e.date_status,
                    Jsonb(e.facts),
                    Jsonb(e.body),
                    e.legacy_id,
                    e.listed,
                    e.search_text,
                ),
            ).fetchone()
            if res and res[0]:
                inserted += 1
            else:
                updated += 1
    return inserted, updated
