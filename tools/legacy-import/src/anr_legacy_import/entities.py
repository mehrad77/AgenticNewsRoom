"""The old wiki's organisations, products and people as Reference entries, and the links to them.

Sources: the KB's entities (labs, orgs, products, a person), the old site's alias table and its
Wikidata cache (CC0 labels, descriptions and facts, in Persian and English). Organisations from
every source are merged by Wikidata QID; people are authors with two or more listed classic
papers, one person per first and last name with initials dropped (D165). An entity gets an entry
only when something on the site points at it.
"""

import re
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any

from .mapping import ORG_FA, Entry, Row, slugify

PERSIAN = re.compile(r"[؀-ۿ]")
WIKIDATA_FACTS = (
    "website",
    "inception",
    "dissolved",
    "hq",
    "founders",
    "parent",
    "developer",
    "employer",
    "replaces",
    "orcid",
    "dblp",
    "scholar",
)
SUFFIXES = {"the", "inc", "ltd", "llc", "corp", "corporation", "co"}
# Free Wikimedia Commons licences ANR publishes images under (D119); anything else gets no image.
FREE_LICENCES = re.compile(r"^(Public domain|CC0|CC BY(-SA)? \d\.\d( [a-z]{2})?)$")


def norm(s: str) -> str:
    """Lowercase ASCII words, without 'the' or a company suffix."""
    ascii_text = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return " ".join(w for w in re.sub(r"[^a-z0-9]+", " ", ascii_text).split() if w not in SUFFIXES)


def person_key(name: str) -> str:
    """First and last name with initials dropped: 'Geoffrey E. Hinton' -> 'geoffrey hinton'."""
    words = [w for w in norm(name).split() if len(w) > 1]
    return f"{words[0]} {words[-1]}" if len(words) >= 2 else " ".join(words)


@dataclass
class Entity:
    key: str
    kind: str  # organisation | product | person
    name: str
    aliases: set[str] = field(default_factory=set)
    wikidata: dict[str, Any] = field(default_factory=dict)
    entity_kind: str | None = None
    org_class: str | None = None

    @property
    def qid(self) -> str | None:
        q = self.wikidata.get("qid")
        return q if isinstance(q, str) else None


@dataclass
class Linked:
    entries: list[Entry]
    # (from legacy id, to legacy id, link kind, label as the source wrote it)
    links: list[tuple[str, str, str, str]]


def _wd(cache: dict[str, Any], key: str) -> dict[str, Any]:
    v = cache.get(key)
    return v if isinstance(v, dict) else {}


def _organisations(
    kb: list[Row], cache: dict[str, Any], aliases: dict[str, list[str]], news: list[Row]
) -> list[Entity]:
    found: list[Entity] = []
    for e in kb:
        if e["kind"] in ("lab", "org"):
            meta = _wd(cache, f"lab:{e['id']}")
            found.append(
                Entity(
                    key=f"lab:{e['id']}",
                    kind="organisation",
                    name=e["name"],
                    aliases=set(e.get("aliases") or []),
                    wikidata=meta,
                    entity_kind=e["kind"],
                    org_class=meta.get("class"),
                )
            )
    for canon, more in aliases.items():
        found.append(
            Entity(
                key=f"org:{norm(canon)}",
                kind="organisation",
                name=canon,
                aliases=set(more),
                wikidata=_wd(cache, f"org:{norm(canon)}"),
                entity_kind="org",
            )
        )
    for k, meta in cache.items():
        if k.startswith("org:") and not any(o.key == k for o in found):
            label = (meta.get("label") or {}).get("en") or k.removeprefix("org:")
            found.append(
                Entity(key=k, kind="organisation", name=label, wikidata=meta, entity_kind="org")
            )
    for r in news:
        org = r.get("org")
        if org and not any(norm(org) in {norm(a) for a in [o.name, *o.aliases]} for o in found):
            found.append(
                Entity(
                    key=f"news:{norm(org)}",
                    kind="organisation",
                    name=org,
                    wikidata=_wd(cache, f"news:{norm(org)}"),
                    entity_kind="org",
                )
            )
    # One organisation per QID, or per English name when one has no QID: the KB's entity first,
    # then the alias table's, then the news timeline's.
    rank = {"lab": 0, "org": 1, "news": 2}
    found.sort(key=lambda o: rank[o.key.split(":")[0]])
    seen: dict[str, Entity] = {}
    merged: list[Entity] = []
    for o in found:
        label = (o.wikidata.get("label") or {}).get("en")
        keys = [k for k in (o.qid, f"name:{norm(o.name)}", label and f"name:{norm(label)}") if k]
        keep = next((seen[k] for k in keys if k in seen), None)
        if keep:
            keep.aliases |= {o.name, *o.aliases}
            if not keep.qid and o.qid:
                keep.wikidata = o.wikidata
            for k in keys:
                seen.setdefault(k, keep)
            continue
        for k in keys:
            seen[k] = o
        merged.append(o)
    return merged


def _index(entities: list[Entity]) -> dict[str, Entity]:
    out: dict[str, Entity] = {}
    for e in entities:
        for n in [e.name, *e.aliases]:
            k = norm(n)
            if k and not PERSIAN.search(n):
                out.setdefault(k, e)
    return out


def _affiliation(text: str, index: dict[str, Entity]) -> Entity | None:
    """The organisation whose name is the longest whole-word part of an affiliation line."""
    t = f" {norm(text)} "
    best: tuple[int, Entity] | None = None
    for k, e in index.items():
        if len(k) >= 3 and f" {k} " in t and (best is None or len(k) > best[0]):
            best = (len(k), e)
    return best[1] if best else None


def _names(e: Entity) -> dict[str, str]:
    """The old site's names first (the KB's, the news timeline's), then Wikidata's labels."""
    label = e.wikidata.get("label") or {}
    from_cache_only = e.key.startswith("org:") and e.name == e.key.removeprefix("org:")
    en = (label.get("en") or e.name) if from_cache_only or e.kind == "person" else e.name
    fa = (
        ORG_FA.get(e.name)
        or next((a for a in sorted(e.aliases) if PERSIAN.search(a)), None)
        or label.get("fa")
        or en
    )
    return {"fa": fa, "en": en}


def _entry(e: Entity, slug: str) -> Entry:
    names = _names(e)
    desc = {k: v for k, v in (e.wikidata.get("description") or {}).items() if v}
    facts_wd = e.wikidata.get("facts") or {}
    aliases = sorted(a for a in e.aliases if a not in names.values())
    facts: dict[str, Any] = {
        "names": names,
        "description": desc,
        "qid": e.qid,
        "aliases": aliases,
        "wikidata": {k: facts_wd[k] for k in WIKIDATA_FACTS if facts_wd.get(k)},
        "entity_kind": e.entity_kind,
        "class": e.org_class,
    }
    image = e.wikidata.get("image")
    if (
        isinstance(image, dict)
        and FREE_LICENCES.match(str(image.get("license") or ""))
        and image.get("artist")
        and image.get("commonsUrl")
    ):
        # Stored as a licensed media item at import (write.py); the site shows it with its credit.
        facts["image_source"] = {
            "src": image["src"],
            "licence": image["license"],
            "licence_url": image.get("licenseUrl") or image["commonsUrl"],
            "artist": image["artist"],
            "commons_url": image["commonsUrl"],
            "width": image.get("width"),
            "height": image.get("height"),
            "role": "photo" if e.kind == "person" else "logo",
        }
    return Entry(
        legacy_id=f"entity:{e.key}",
        kind=e.kind,
        slug=slug,
        title=names["en"],
        date=None,
        date_status=None,
        facts=facts,
        body={},
        listed=True,
        search_text=" ".join([*names.values(), *aliases, *desc.values()]),
    )


def link_entities(
    kb: list[Row],
    cache: dict[str, Any],
    org_aliases: dict[str, list[str]],
    news_rows: list[Row],
    classic_rows: list[Row],
    entries: list[Entry],
) -> Linked:
    """Entries for the organisations, products and people the news and classics name, and the
    links from those news items and papers to them."""
    orgs = _organisations(kb, cache, org_aliases, news_rows)
    org_index = _index(orgs)
    products = [
        Entity(
            key=f"lab:{e['id']}",
            kind="product" if e["kind"] == "product" else "person",
            name=e["name"],
            aliases=set(e.get("aliases") or []),
            wikidata=_wd(cache, f"lab:{e['id']}"),
            entity_kind=e["kind"],
        )
        for e in kb
        if e["kind"] in ("product", "person")
    ]
    product_index = _index(products)

    by_legacy = {e.legacy_id: e for e in entries}
    links: list[tuple[str, str, str, str]] = []
    used: dict[str, Entity] = {}

    def use(e: Entity) -> str:
        used[e.key] = e
        return f"entity:{e.key}"

    for r in news_rows:
        src = f"lab-news:{r['id']}"
        if src not in by_legacy or not by_legacy[src].listed:
            continue
        org = r.get("org")
        if org and (o := org_index.get(norm(org))):
            links.append((src, use(o), "made-by", org))
        for name in r.get("entities") or []:
            target = product_index.get(norm(name)) or org_index.get(norm(name))
            if target is None:
                target = Entity(key=f"chip:{norm(name)}", kind="product", name=name)
                product_index[norm(name)] = target
            if not (org and norm(name) == norm(org)):
                links.append((src, use(target), "mentions", name))

    # People: authors of two or more listed classics, merged across spellings.
    listed = [c for c in classic_rows if by_legacy.get(f"classic:{c['slug']}")]
    listed = [c for c in listed if by_legacy[f"classic:{c['slug']}"].listed]
    spellings: dict[str, Counter[str]] = defaultdict(Counter)
    papers: dict[str, set[str]] = defaultdict(set)
    for c in listed:
        for a in c.get("authors") or []:
            k = person_key(a)
            if k:
                spellings[k][a] += 1
                papers[k].add(c["slug"])
    people = {
        k: Entity(
            key=f"author:{k}",
            kind="person",
            name=(_wd(cache, f"author:{k}").get("label") or {}).get("en")
            or spellings[k].most_common(1)[0][0],
            aliases=set(spellings[k]),
            wikidata=_wd(cache, f"author:{k}"),
        )
        for k, slugs in papers.items()
        if len(slugs) >= 2
    }
    for c in listed:
        src = f"classic:{c['slug']}"
        for a in c.get("authors") or []:
            if p := people.get(person_key(a)):
                links.append((src, use(p), "written-by", a))
        for a in c.get("affiliations") or []:
            if o := _affiliation(a, org_index):
                links.append((src, use(o), "affiliated-with", a))

    # An organisation known only by its cache key takes the name its sources wrote most often.
    written: dict[str, Counter[str]] = defaultdict(Counter)
    for _, to_id, _, label in links:
        written[to_id][label] += 1
    for e in used.values():
        if e.name == e.key.split(":", 1)[1] and not (e.wikidata.get("label") or {}).get("en"):
            e.name = written[f"entity:{e.key}"].most_common(1)[0][0]

    # Slugs from the English name; a clash takes the next number.
    taken: set[tuple[str, str]] = set()
    out: list[Entry] = []
    for e in sorted(used.values(), key=lambda e: (e.kind, e.key)):
        base = slugify(_names(e)["en"], 60) or slugify(e.key.split(":", 1)[1], 60) or "entry"
        slug, n = base, 2
        while (e.kind, slug) in taken:
            slug, n = f"{base}-{n}", n + 1
        taken.add((e.kind, slug))
        out.append(_entry(e, slug))
    return Linked(entries=out, links=sorted(set(links)))
