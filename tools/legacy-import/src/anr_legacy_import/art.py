"""The old podcast's own artwork (D180): its show art and header, each episode's cover and each
host's avatar, made with AI for the newsroom. Each file goes into the raw store, as other imported
images do, and becomes a media item with licence kind `own`, credited to the newsroom. Show art,
header and avatars carry a `role` the site finds them by; a cover is named on its episode."""

import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg

from .images import CONTENT_TYPES
from .podcasts import SERIES, USER_AGENT

MEDIA = "https://media.newsroom.shab.boo"
# The old site's show art and its 16:9 header (apps/archive/src/lib/site.ts).
SHOW_ART = f"{MEDIA}/covers/show-c1fd2f56-1400.jpg"
HERO = f"{MEDIA}/covers/hero-56b13f99-1280.jpg"
SHOW_ALT = (
    "نیلوفر در وسط پشت میکروفون حرف می‌زند، فرزاد پشت سرش در سمت چپ و اِبی با کلاه کپ در سمت"
    " راست؛ بالای تصویر زمینه‌ای آرام به رنگ شنی است."
)
# IPTC digital source type of an image made by generative AI.
AI_MADE = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"

INSERT = """
insert into media
  (newsroom_id, file, lead_id, creator, credit_line, copyright_notice, licence, source_url,
   file_url, content_type, description, added_by, licence_kind, licence_recorded_at,
   digital_source_type, role)
values (%s, %s, null, %s, %s, %s, 'All rights reserved', %s, %s, %s, %s, %s, 'own',
        now(), %s, %s)
on conflict (newsroom_id, lead_id, file) do update set
  role = coalesce(excluded.role, media.role), description = excluded.description
returning id
"""


@dataclass
class Art:
    url: str
    description: str
    # The name the site finds it by, or None for an episode cover (named on its episode).
    role: str | None = None
    # The episode slug a cover belongs to.
    episode: str | None = None


def wanted(episodes: list[dict[str, Any]], hosts: list[dict[str, Any]]) -> list[Art]:
    out = [
        Art(SHOW_ART, SHOW_ALT, f"series/{SERIES}/show"),
        Art(HERO, SHOW_ALT, f"series/{SERIES}/hero"),
    ]
    for h in hosts:
        url = h.get("avatar_512_url") or h.get("avatar_url")
        if url:
            out.append(
                Art(str(url), str(h.get("name_fa") or h["id"]), f"series/{SERIES}/host/{h['id']}")
            )
    for e in episodes:
        cover = e.get("cover_url")
        if e.get("status") == "published" and cover and cover != "None":
            out.append(
                Art(str(cover), str(e.get("cover_alt_fa") or e["title_fa"]), episode=str(e["slug"]))
            )
    return out


def content_type_of(url: str) -> str:
    """The image's type from its file name, as images.py reads Commons files."""
    ext = url.split("?", 1)[0].rsplit(".", 1)[-1].lower()
    if ext not in CONTENT_TYPES:
        raise SystemExit(f"artwork {url} is not a png, jpeg or webp file")
    return CONTENT_TYPES[ext]


def _get(url: str, cache: Path | None) -> bytes:
    name = url.rsplit("/", 1)[-1]
    if cache and (cache / name).exists():
        return (cache / name).read_bytes()
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        data: bytes = response.read()
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
        (cache / name).write_bytes(data)
    return data


def store_art(
    conn: psycopg.Connection[Any], newsroom_id: object, art: list[Art], cache: Path | None
) -> dict[str, dict[str, str]]:
    """Stores each image and returns the covers, by episode slug: {media_id, alt}."""
    row = conn.execute(
        "select m.user_id, n.name->>'fa', n.name->>'en' from memberships m"
        " join newsrooms n on n.id = m.newsroom_id"
        " where m.newsroom_id = %s and m.role = 'editor-in-chief' order by m.created_at limit 1",
        (newsroom_id,),
    ).fetchone()
    if row is None:
        print("artwork: skipped (the newsroom has no Editor-in-Chief yet)")
        return {}
    added_by, name_fa, name_en = row
    credit = name_en or name_fa
    from anr_ingestion.settings import Settings

    store = Settings.from_env().raw_store()
    covers: dict[str, dict[str, str]] = {}
    for a in art:
        content_type = content_type_of(a.url)
        key = store.put(_get(a.url, cache), content_type)
        if a.role:
            # A role moves to the newest file that takes it.
            conn.execute(
                "update media set role = null where newsroom_id = %s and role = %s and file <> %s",
                (newsroom_id, a.role, key),
            )
        found = conn.execute(
            INSERT,
            (
                newsroom_id,
                key,
                credit,
                f"{credit} (AI-made)",
                f"© {credit}",
                a.url,
                a.url,
                content_type,
                a.description,
                added_by,
                AI_MADE,
                a.role,
            ),
        ).fetchone()
        assert found
        if a.episode:
            covers[a.episode] = {"media_id": str(found[0]), "alt": a.description}
    print(f"artwork: {len(art)} images stored as the newsroom's own")
    return covers
