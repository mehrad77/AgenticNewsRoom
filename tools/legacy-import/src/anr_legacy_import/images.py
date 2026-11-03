"""Images entries show (D119): each permitted Wikimedia Commons file from the old site stored in
the raw store, as ingestion stores sources, and recorded as a licensed media item with its credit.
The publisher makes the signed copy the site serves (D120); nothing here publishes."""

from dataclasses import replace
from pathlib import Path
from typing import Any

import psycopg

from .mapping import Entry

CONTENT_TYPES = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
}

INSERT = """
insert into media
  (newsroom_id, file, lead_id, creator, credit_line, web_statement, licence, source_url, file_url,
   content_type, description, added_by, licence_kind, licence_url, licence_recorded_at)
values (%s, %s, null, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'commons', %s, now())
on conflict (newsroom_id, lead_id, file) do nothing
returning id
"""


def store_images(
    conn: psycopg.Connection[Any], newsroom_id: object, entries: list[Entry], public: Path | None
) -> tuple[list[Entry], int]:
    """Entries with `facts.image` (a media id) in place of `facts.image_source`."""

    def without(e: Entry, image: dict[str, Any] | None = None) -> Entry:
        facts = {k: v for k, v in e.facts.items() if k != "image_source"}
        if image:
            facts["image"] = image
        return replace(e, facts=facts)

    wanted = [e for e in entries if "image_source" in e.facts]
    if not wanted:
        return entries, 0
    # A media item names who added it: the newsroom's Editor-in-Chief, for whom the import runs.
    row = conn.execute(
        "select user_id from memberships where newsroom_id = %s and role = 'editor-in-chief'"
        " order by created_at limit 1",
        (newsroom_id,),
    ).fetchone()
    if public is None or row is None:
        reason = "no --site-data" if public is None else "the newsroom has no Editor-in-Chief yet"
        print(f"images: skipped ({reason})")
        return [without(e) for e in entries], 0
    added_by = row[0]
    from anr_ingestion.settings import Settings

    store = Settings.from_env().raw_store()
    out: list[Entry] = []
    stored = 0
    for e in entries:
        src = e.facts.get("image_source")
        if not isinstance(src, dict):
            out.append(e)
            continue
        path = public / str(src["src"]).lstrip("/")
        ctype = CONTENT_TYPES.get(path.suffix.lstrip(".").lower())
        if not path.exists() or ctype is None:
            out.append(without(e))
            continue
        key = store.put(path.read_bytes(), ctype)
        role = "Photo" if src["role"] == "photo" else "Logo"
        found = (
            conn.execute(
                INSERT,
                (
                    newsroom_id,
                    key,
                    src["artist"],
                    f"{src['artist']}, via Wikimedia Commons",
                    src["commons_url"],
                    src["licence"],
                    src["commons_url"],
                    src["commons_url"],
                    ctype,
                    f"{role} of {e.title}",
                    added_by,
                    src["licence_url"],
                ),
            ).fetchone()
            or conn.execute(
                "select id from media where newsroom_id = %s and lead_id is null and file = %s",
                (newsroom_id, key),
            ).fetchone()
        )
        assert found is not None
        stored += 1
        out.append(
            without(
                e,
                {
                    "media_id": str(found[0]),
                    "role": src["role"],
                    "width": src.get("width"),
                    "height": src.get("height"),
                    "content_type": ctype,
                },
            )
        )
    return out, stored
