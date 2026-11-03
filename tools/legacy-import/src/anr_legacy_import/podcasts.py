"""The old podcast's episodes, as imported episodes of the newsroom's podcast series (D177).

Each published episode becomes a published publication in Persian with `origin = imported`: its
audio copied into the media store, an `episodes` row as the producer writes one, and a rendition
holding its title, summary, chapters and transcript. The old episode pages and feed redirect to
their new addresses through the URL map.
"""

import ast
import os
import urllib.request
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from .slots import pipeline_holds

SERIES = "weekly-podcast"
LANGUAGE = "fa"
# IPTC digital source type of an episode voiced by AI and not edited by a person (packages/core).
AI_VOICED = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"
# The old media host refuses clients that do not name themselves.
USER_AGENT = "ANR-legacy-import/0.1"
MEDIA_DIR = Path(__file__).resolve().parents[4] / ".data" / "media"


@dataclass
class Episode:
    slug: str
    kind: str
    slot: datetime
    title: str
    summary: str
    transcript: str
    audio_url: str
    seconds: int
    # The classic paper the episode tells, by its slug.
    classic: str | None
    # [{"title", "start", "end"}], as the producer stores chapters.
    chapters: list[dict[str, Any]]

    @property
    def path(self) -> str:
        return f"/{SERIES}/{self.slot.date().isoformat()}-{self.kind}"

    def body(self) -> dict[str, Any]:
        return {
            "language": LANGUAGE,
            "title": self.title,
            "summary": self.summary,
            "chapters": self.chapters,
            "transcript": self.transcript,
        }


def _list(value: Any) -> list[Any]:
    """A list from the export, which writes some lists as Python reprs."""
    if isinstance(value, list):
        return value
    if isinstance(value, str) and value.startswith("["):
        parsed = ast.literal_eval(value)
        return parsed if isinstance(parsed, list) else []
    return []


def episodes(rows: list[dict[str, Any]]) -> list[Episode]:
    """The published episodes, oldest first."""
    out: list[Episode] = []
    for r in rows:
        if r.get("status") != "published" or not r.get("audio_url"):
            continue
        seconds = int(r["duration_sec"])
        marks = sorted(_list(r.get("chapters")), key=lambda c: float(c["start_sec"]))
        chapters = [
            {
                "title": str(c.get("title_fa") or "").strip(),
                "start": float(c["start_sec"]),
                "end": float(marks[i + 1]["start_sec"]) if i + 1 < len(marks) else float(seconds),
            }
            for i, c in enumerate(marks)
        ]
        out.append(
            Episode(
                slug=str(r["slug"]),
                kind=str(r.get("kind") or "episode"),
                slot=datetime.fromisoformat(str(r["published_at"])),
                title=str(r["title_fa"]).strip(),
                summary=str(r.get("summary_fa") or "").strip(),
                transcript=str(r.get("transcript_md") or "").strip(),
                audio_url=str(r["audio_url"]),
                seconds=seconds,
                classic=str(r["classic_slug"])
                if r.get("classic_slug") not in (None, "None")
                else None,
                chapters=chapters,
            )
        )
    return sorted(out, key=lambda e: e.slot)


def url_map(found: list[Episode]) -> dict[str, str]:
    """The old podcast pages and feed, to their new addresses."""
    return {
        "/podcast/": f"/podcast/{SERIES}.xml",
        "/podcast/feed.xml": f"/podcast/{SERIES}.xml",
        **{f"/podcast/{e.slug}/": e.path for e in found},
    }


def fetch(url: str, cache: Path | None) -> bytes:
    """An episode's audio, from the cache directory when it holds it."""
    name = url.rsplit("/", 1)[-1]
    if cache and (cache / name).exists():
        return (cache / name).read_bytes()
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        data: bytes = response.read()
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
        (cache / name).write_bytes(data)
    return data


def put_audio(key: str, data: bytes) -> None:
    """Into the media store: the media bucket when set (production, D132), else ANR_MEDIA_DIR."""
    bucket = os.environ.get("ANR_MEDIA_BUCKET")
    if not bucket:
        path = Path(os.environ.get("ANR_MEDIA_DIR") or MEDIA_DIR) / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return
    from anr_ingestion.rawstore import S3RawStore
    from anr_ingestion.settings import Settings

    store = replace(Settings.from_env(), raw_bucket=bucket).raw_store()
    assert isinstance(store, S3RawStore)
    store.client.put_object(Bucket=bucket, Key=key, Body=data, ContentType="audio/mpeg")


def write_episodes(
    conn: psycopg.Connection[Any],
    newsroom_id: object,
    found: list[Episode],
    cache: Path | None,
    covers: dict[str, dict[str, str]] | None = None,
) -> int:
    row = conn.execute(
        "select id, format_id from series where newsroom_id = %s and slug = %s",
        (newsroom_id, SERIES),
    ).fetchone()
    if not row:
        raise SystemExit(f"the newsroom has no series {SERIES!r}")
    series_id, format_id = row
    written = 0
    for e in found:
        if pipeline_holds(conn, newsroom_id, series_id, e.slot):
            continue  # the pipeline already published this slot
        assignment = conn.execute(
            "insert into assignments (newsroom_id, series_id, slot) values (%s, %s, %s)"
            " on conflict (newsroom_id, series_id, slot) do update set slot = excluded.slot"
            " returning id",
            (newsroom_id, series_id, e.slot),
        ).fetchone()
        assert assignment
        conn.execute(
            "insert into stories (newsroom_id, assignment_id) select %(n)s, %(a)s"
            " where not exists (select from stories where assignment_id = %(a)s)",
            {"n": newsroom_id, "a": assignment[0]},
        )
        rendition = conn.execute(
            "insert into renditions (newsroom_id, story_id, format_id, language, body)"
            " select %s, s.id, %s, %s, %s from stories s where s.assignment_id = %s"
            " order by s.created_at limit 1"
            " on conflict (newsroom_id, story_id, format_id, language)"
            " do update set body = excluded.body returning id",
            (
                newsroom_id,
                format_id,
                LANGUAGE,
                Jsonb(
                    {
                        **e.body(),
                        **({"cover": covers[e.slug]} if covers and e.slug in covers else {}),
                    }
                ),
                assignment[0],
            ),
        ).fetchone()
        assert rendition
        publication = conn.execute(
            "insert into publications (newsroom_id, series_id, assignment_id, slot, language,"
            " status, published_at, path, title, search_text, origin)"
            " values (%s, %s, %s, %s, %s, 'published', %s, %s, %s, %s, 'imported')"
            " on conflict (newsroom_id, series_id, slot, language) do update set"
            " title = excluded.title, search_text = excluded.search_text, path = excluded.path,"
            " updated_at = now() where publications.origin = 'imported' returning id",
            (
                newsroom_id,
                series_id,
                assignment[0],
                e.slot,
                LANGUAGE,
                e.slot,
                e.path,
                e.title,
                f"{e.title} {e.summary}",
            ),
        ).fetchone()
        if not publication:
            continue  # the pipeline already published this slot
        conn.execute(
            "insert into publication_renditions"
            " (newsroom_id, publication_id, position, rendition_id) values (%s, %s, 1, %s)"
            " on conflict (publication_id, position)"
            " do update set rendition_id = excluded.rendition_id",
            (newsroom_id, publication[0], rendition[0]),
        )
        stored = conn.execute(
            "select 1 from episodes where publication_id = %s and script_hash = %s",
            (publication[0], e.slug),
        ).fetchone()
        if not stored:
            data = fetch(e.audio_url, cache)
            key = f"episodes/{publication[0]}/{e.slug}.mp3"
            put_audio(key, data)
            conn.execute(
                "insert into episodes (newsroom_id, publication_id, rendition_id, script_hash,"
                " media_key, bytes, seconds, chapters, digital_source_type, signed)"
                " values (%s, %s, %s, %s, %s, %s, %s, %s, %s, false)",
                (
                    newsroom_id,
                    publication[0],
                    rendition[0],
                    e.slug,
                    key,
                    len(data),
                    e.seconds,
                    Jsonb(e.chapters),
                    AI_VOICED,
                ),
            )
        written += 1
    return written
