"""Writes imported entries in one transaction, as the system role, in the newsroom's setting."""

from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from .images import store_images
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


def write(
    url: str,
    newsroom: str,
    entries: list[Entry],
    links: list[tuple[str, str, str, str]],
    public: Path | None = None,
) -> tuple[int, int]:
    inserted = updated = 0
    with psycopg.connect(url) as conn, conn.transaction():
        row = conn.execute(
            "select id, reference from newsrooms where slug = %s and removed_at is null",
            (newsroom,),
        ).fetchone()
        if not row:
            raise SystemExit(f"no newsroom {newsroom!r}; run pnpm config:sync")
        newsroom_id, reference = row
        # Only the kinds the newsroom's reference.yaml declares (D170).
        kinds = set((reference or {}).get("kinds", {}))
        unknown = sorted({e.kind for e in entries} - kinds)
        if unknown:
            raise SystemExit(f"newsroom {newsroom!r} has no Reference kind {', '.join(unknown)}")
        conn.execute("select set_config('anr.newsroom_id', %s, true)", (str(newsroom_id),))
        entries, images = store_images(conn, newsroom_id, entries, public)
        print(f"images: {images} stored as licensed media")
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
        # The imported entries' links, rebuilt from the export each run.
        ids: dict[str, object] = dict(
            conn.execute(
                "select legacy_id, id from reference_entries where origin = 'imported'"
                " and newsroom_id = %s",
                (newsroom_id,),
            ).fetchall()
        )
        conn.execute(
            "delete from reference_entry_links l using reference_entries e"
            " where e.id = l.from_entry and e.origin = 'imported' and l.newsroom_id = %s",
            (newsroom_id,),
        )
        with conn.cursor() as cur:
            cur.executemany(
                "insert into reference_entry_links (newsroom_id, from_entry, to_entry, kind, label)"
                " values (%s, %s, %s, %s, %s) on conflict do nothing",
                [
                    (newsroom_id, ids[a], ids[b], kind, label)
                    for a, b, kind, label in links
                    if a in ids and b in ids
                ],
            )
    return inserted, updated
