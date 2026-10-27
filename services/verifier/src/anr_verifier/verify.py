"""Layer 1 of the verifier gate: load a story, run every code check, store each result as a Check
(D79). The checks are pure; this module is the only one that reads or writes Postgres."""

import json
from pathlib import Path
from typing import Any

from psycopg_pool import ConnectionPool

from anr_verifier import claims, items, rendition
from anr_verifier.bundle import Bundle, CheckOut, Claim, Lead, Policy, Rendition, Source
from anr_verifier.db import Conn, with_newsroom


class StoryNotFound(LookupError):
    pass


# A lead's publisher, for source independence: the source's publisher, else the host of the
# lead's URL without "www." (a lead an agent requested from an unknown site has no source).
_PUBLISHER = (
    "coalesce(s.publisher, regexp_replace(substring(l.uri from '^[a-z]+://([^/:]+)'), "
    "'^www\\.', ''))"
)


def load(conn: Conn, story_id: str) -> Bundle:
    story = conn.execute(
        """select s.id, b.slug as beat, n.policy
           from stories s join newsrooms n on n.id = s.newsroom_id
           left join beats b on b.id = s.beat_id
           where s.id = %s""",
        (story_id,),
    ).fetchone()
    if story is None:
        raise StoryNotFound(story_id)
    beats = {
        str(r["slug"]): str(r["status"])
        for r in conn.execute("select slug, status from beats where removed_at is null")
    }
    claim_rows = conn.execute(
        """select c.id, c.ref, c.kind, c.text, c.lead_id, c.quoted_passage,
                  coalesce((select json_agg(json_build_object('lead_id', cs.lead_id,
                                                              'quoted_passage', cs.quoted_passage)
                                            order by cs.position)
                            from claim_sources cs where cs.claim_id = c.id), '[]') as also
           from claims c where c.story_id = %s order by c.created_at, c.ref""",
        (story_id,),
    ).fetchall()
    story_claims = tuple(
        Claim(
            id=str(r["id"]),
            ref=str(r["ref"]),
            kind=str(r["kind"]),
            text=str(r["text"]),
            lead_id=str(r["lead_id"]) if r["lead_id"] else None,
            quoted_passage=r["quoted_passage"],
            also=tuple(Source(str(a["lead_id"]), str(a["quoted_passage"])) for a in r["also"]),
        )
        for r in claim_rows
    )
    renditions = tuple(
        Rendition(str(r["id"]), str(r["language"]), str(r["format"]), r["body"])
        for r in conn.execute(
            """select r.id, r.language, f.slug as format, r.body
               from renditions r join formats f on f.id = r.format_id
               where r.story_id = %s order by r.created_at""",
            (story_id,),
        )
    )
    lead_ids = {s.lead_id for c in story_claims for s in c.sources()} | {
        str(item["lead_id"])
        for r in renditions
        for _, item in items.walk(r.body)
        if item.get("lead_id")
    }
    leads = {
        str(r["id"]): Lead(
            id=str(r["id"]),
            body=str(r["body"]),
            language=str(r["language"]),
            tier=int(r["tier"]),
            publisher=str(r["publisher"]),
            withdrawn=r["withdrawn_reason"],
            beats=dict(r["beats"]),
        )
        for r in conn.execute(
            f"""select l.id, l.body, l.language, l.tier, {_PUBLISHER} as publisher,
                       l.withdrawn_reason,
                       coalesce((select json_object_agg(b.slug, b.status) from lead_beats lb
                                 join beats b on b.id = lb.beat_id where lb.lead_id = l.id),
                                '{{}}') as beats
                from leads l left join sources s on s.id = l.source_id
                where l.id::text = any(%s)""",
            (sorted(lead_ids),),
        )
    }
    policy: dict[str, Any] = story["policy"] or {}
    sources = policy.get("sources", {})
    return Bundle(
        story_id=story_id,
        beat=story["beat"],
        beats=beats,
        claims=story_claims,
        leads=leads,
        renditions=renditions,
        policy=Policy(
            min_independent=int(sources.get("min_independent", 2)),
            tier1_alone=bool(sources.get("tier1_alone", False)),
            opinion=str(policy.get("opinion", "not_allowed")),
        ),
    )


def item_leads(b: Bundle) -> list[CheckOut]:
    """An item that points readers at a lead (an outside article) names a stored, live lead."""
    out = []
    for r in b.renditions:
        for path, item in items.walk(r.body):
            if not item.get("lead_id"):
                continue
            lead = b.leads.get(str(item["lead_id"]))
            ok = lead is not None and not lead.withdrawn
            out.append(
                CheckOut(
                    "item-lead",
                    "pass" if ok else "fail",
                    rendition_id=r.id,
                    item=path,
                    detail={"lead_id": item["lead_id"], "found": lead is not None},
                )
            )
    return out


def run_checks(b: Bundle, config_dir: Path) -> list[CheckOut]:
    if not b.claims:
        # The schema result too, so the gate sees the code checks ran and does not ask again.
        return [
            CheckOut("claims", "fail", detail={"error": "the story has no claims"}),
            *rendition.schema(b),
        ]
    return [
        *rendition.schema(b),
        *claims.quotes(b),
        *claims.independence(b),
        *claims.opinion(b),
        *claims.beats(b),
        *items.item_claims(b),
        *item_leads(b),
        *rendition.style_lint(b),
        *rendition.format_rules(b, config_dir),
    ]


def store(conn: Conn, b: Bundle, checks: list[CheckOut]) -> list[dict[str, Any]]:
    """Each check as a row; a story-wide one is stored once per rendition, so every language's
    publication shows it."""
    stored = []
    for check in checks:
        anchors: list[str | None] = (
            [check.rendition_id]
            if check.claim_id or check.rendition_id
            else [r.id for r in b.renditions]
        )
        for rendition_id in anchors:
            if check.claim_id is None and rendition_id is None:
                continue
            row = conn.execute(
                """insert into checks (newsroom_id, claim_id, rendition_id, item, kind, name,
                                       result, detail)
                   values (anr.current_newsroom_id(), %s, %s, %s, 'code', %s, %s, %s)
                   returning id""",
                (
                    check.claim_id,
                    rendition_id,
                    check.item,
                    check.name,
                    check.result,
                    json.dumps(check.detail, ensure_ascii=False),
                ),
            ).fetchone()
            assert row is not None
            stored.append(
                {
                    "id": str(row["id"]),
                    "name": check.name,
                    "result": check.result,
                    "claim_id": check.claim_id,
                    "rendition_id": rendition_id,
                    "item": check.item,
                    "detail": check.detail,
                }
            )
    return stored


def verify(
    pool: ConnectionPool[Conn], config_dir: Path, newsroom_id: str, story_id: str
) -> list[dict[str, Any]]:
    """Runs the code checks on a story in one transaction and stores every result."""
    with with_newsroom(pool, newsroom_id) as conn:
        bundle = load(conn, story_id)
        return store(conn, bundle, run_checks(bundle, config_dir))
