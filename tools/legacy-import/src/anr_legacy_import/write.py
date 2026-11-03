"""Writes imported entries and pieces in one transaction, as the system role, in the newsroom's
setting."""

from dataclasses import replace
from pathlib import Path
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from .images import store_images
from .mapping import Entry
from .pieces import CLASSIC_SERIES, Piece, classic_pieces, news_issues

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

# A piece (D172): its assignment, story and rendition, then the published publication. An imported
# publication never replaces one the pipeline made for the same slot.
ASSIGNMENT = """
insert into assignments (newsroom_id, series_id, slot) values (%s, %s, %s)
on conflict (newsroom_id, series_id, slot) do update set slot = excluded.slot
returning id
"""
STORY = """
insert into stories (newsroom_id, assignment_id)
select %(n)s, %(a)s where not exists (select from stories where assignment_id = %(a)s)
"""
RENDITION = """
insert into renditions (newsroom_id, story_id, format_id, language, body)
select %s, s.id, %s, %s, %s from stories s where s.assignment_id = %s
order by s.created_at limit 1
on conflict (newsroom_id, story_id, format_id, language) do update set body = excluded.body
returning id
"""
PUBLICATION = """
insert into publications (newsroom_id, series_id, assignment_id, slot, language, status,
  published_at, path, title, search_text, origin)
values (%s, %s, %s, %s, %s, 'published', %s, %s, %s, %s, 'imported')
on conflict (newsroom_id, series_id, slot, language) do update set
  title = excluded.title, search_text = excluded.search_text, path = excluded.path,
  updated_at = now()
where publications.origin = 'imported'
returning id
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
            "select id, reference, timezone from newsrooms where slug = %s and removed_at is null",
            (newsroom,),
        ).fetchone()
        if not row:
            raise SystemExit(f"no newsroom {newsroom!r}; run pnpm config:sync")
        newsroom_id, reference, timezone = row
        kinds = set((reference or {}).get("kinds", {}))
        # The archive's news and posted classics are pieces (D172); papers keep a link to theirs.
        sections = (reference or {}).get("kinds", {}).get("paper", {}).get("sections", [])
        pieces = news_issues(entries, links, timezone) + classic_pieces(entries, sections, timezone)
        entries = [_as_work(e) for e in entries if e.kind != "news-event"]
        entry_ids = {e.legacy_id for e in entries}
        links = [x for x in links if x[0] in entry_ids and x[1] in entry_ids]
        # Only the kinds the newsroom's reference.yaml declares (D170).
        unknown = sorted({e.kind for e in entries} - kinds)
        if unknown:
            raise SystemExit(f"newsroom {newsroom!r} has no Reference kind {', '.join(unknown)}")
        conn.execute("select set_config('anr.newsroom_id', %s, true)", (str(newsroom_id),))
        # Imported entries of kinds the Reference no longer has, such as the news events D172 made
        # into pieces, go with their links.
        conn.execute(
            "delete from reference_entry_links l using reference_entries e"
            " where e.newsroom_id = %s and e.origin = 'imported' and not (e.kind = any(%s))"
            " and e.id in (l.from_entry, l.to_entry)",
            (newsroom_id, list(kinds)),
        )
        conn.execute(
            "delete from reference_entries where newsroom_id = %s and origin = 'imported'"
            " and not (kind = any(%s))",
            (newsroom_id, list(kinds)),
        )
        written = write_pieces(conn, newsroom_id, pieces)
        print(f"pieces: {written} imported publications written")
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


def _as_work(e: Entry) -> Entry:
    """A posted classic's paper as a work (D172): its text is its piece's, linked from its facts."""
    day = e.facts.get("posted_date")
    if e.kind != "paper" or not isinstance(day, str):
        return e
    body = {
        lang: {"excerpts": text["excerpts"]}
        for lang, text in e.body.items()
        if text.get("excerpts")
    }
    return replace(e, body=body, facts={**e.facts, "piece": f"/{CLASSIC_SERIES}/{day}"})


def write_pieces(conn: psycopg.Connection[Any], newsroom_id: object, pieces: list[Piece]) -> int:
    series = {
        slug: (sid, fid)
        for slug, sid, fid in conn.execute(
            "select slug, id, format_id from series where newsroom_id = %s", (newsroom_id,)
        ).fetchall()
    }
    written = 0
    for p in pieces:
        if p.series not in series:
            raise SystemExit(f"the newsroom has no series {p.series!r}")
        series_id, format_id = series[p.series]
        assignment = conn.execute(ASSIGNMENT, (newsroom_id, series_id, p.slot)).fetchone()
        assert assignment
        conn.execute(STORY, {"n": newsroom_id, "a": assignment[0]})
        rendition = conn.execute(
            RENDITION, (newsroom_id, format_id, p.language, Jsonb(p.body), assignment[0])
        ).fetchone()
        assert rendition
        publication = conn.execute(
            PUBLICATION,
            (
                newsroom_id,
                series_id,
                assignment[0],
                p.slot,
                p.language,
                p.slot,
                f"/{p.series}/{p.day}",
                p.title,
                p.search_text,
            ),
        ).fetchone()
        if not publication:
            continue  # the pipeline already published this slot
        conn.execute(
            "insert into publication_renditions"
            " (newsroom_id, publication_id, position, rendition_id)"
            " values (%s, %s, 1, %s) on conflict (publication_id, position)"
            " do update set rendition_id = excluded.rendition_id",
            (newsroom_id, publication[0], rendition[0]),
        )
        written += 1
    return written
