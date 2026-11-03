"""The old knowledge base's export, as Reference entries (D165).

Pure functions: rows in, entries out. Which rows are listed follows the old site exactly, so the
Reference shows what readers saw there.
"""

import hashlib
import html
import re
import unicodedata
from dataclasses import dataclass, field, replace
from html.parser import HTMLParser
from typing import Any

Row = dict[str, Any]

# The old site's classic pages: researched or posted, or a candidate with its short summary.
CLASSIC_LISTED = ("researched", "posted")
# Old date statuses, as the Reference names them.
DATE_STATUS = {"verified": "verified", "recorded": "recorded", "post_date": "approximate"}
# The old site's Persian names for the organisations on its news timeline (apps/archive news.ts).
ORG_FA = {
    "OpenAI": "اوپن‌ای‌آی",
    "Anthropic": "آنتروپیک",
    "Google DeepMind": "گوگل دیپ‌مایند",
    "Google": "گوگل",
    "Google Research": "گوگل ریسرچ",
    "xAI": "ایکس‌ای‌آی",
    "Microsoft": "مایکروسافت",
    "Microsoft AI": "مایکروسافت ای‌آی",
    "Microsoft Research": "مایکروسافت ریسرچ",
    "DeepSeek": "دیپ‌سیک",
    "Mistral AI": "میسترال",
    "Meta": "متا",
    "GitHub": "گیت‌هاب",
    "Alibaba Qwen": "علی‌بابا (کوئن)",
    "Anysphere (Cursor)": "کرسر",
    "NVIDIA": "انویدیا",
    "Apple": "اپل",
    "MiniMax": "مینی‌مکس",
    "StepFun": "استپ‌فان",
    "Liquid AI": "لیکوئید ای‌آی",
    "Stability AI": "استبیلیتی ای‌آی",
    "Midjourney": "میدجرنی",
    "Safe Superintelligence": "اس‌اس‌آی",
    "Black Forest Labs": "بلک فارست لبز",
    "Simons Foundation": "بنیاد سایمونز",
    "IBM": "آی‌بی‌ام",
    "iRobot": "آی‌ربات",
    "Amazon": "آمازون",
    "Baidu": "بایدو",
    "Netflix": "نتفلیکس",
    "Stanford University": "دانشگاه استنفورد",
    "University of Toronto": "دانشگاه تورنتو",
    "Université de Montréal": "دانشگاه مونترال",
    "IDSIA / TU Munich": "IDSIA و دانشگاه فنی مونیخ",
}
CLASSIC_SECTIONS = {
    "overview": "summary_fa",
    "problem": "problem_fa",
    "idea": "idea_fa",
    "why": "why_fa",
    "story": "story_fa",
    "after": "after_fa",
}


@dataclass(frozen=True)
class Entry:
    legacy_id: str
    kind: str
    slug: str
    title: str
    date: str | None
    date_status: str | None
    facts: dict[str, Any]
    body: dict[str, dict[str, Any]]
    listed: bool
    search_text: str
    title_language: str = "en"


@dataclass
class Imported:
    entries: list[Entry] = field(default_factory=list)
    # Old site path -> new path inside the newsroom's primary language.
    url_map: dict[str, str] = field(default_factory=dict)
    # (from legacy id, to legacy id, link kind, label as the source wrote it)
    links: list[tuple[str, str, str, str]] = field(default_factory=list)


def slugify(text: str, limit: int = 60) -> str:
    """Lowercase ASCII words joined by hyphens; empty when the text has no ASCII letters."""
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    words = re.findall(r"[a-z0-9]+", ascii_text.lower())
    out = ""
    for w in words:
        nxt = f"{out}-{w}" if out else w
        if len(nxt) > limit:
            break
        out = nxt
    return out


def telegram_url(channel: str | None, message_id: Any) -> str | None:
    if not channel or not isinstance(message_id, int):
        return None
    return f"https://t.me/{channel}/{message_id}"


def _links(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []
    return [
        {"label": str(x.get("label") or x["url"]), "url": x["url"]}
        for x in raw
        if isinstance(x, dict) and isinstance(x.get("url"), str) and x["url"].startswith("http")
    ]


def _date(value: Any) -> tuple[str | None, str | None]:
    """An ISO date and its precision (day, month or year) from `YYYY`, `YYYY-MM` or `YYYY-MM-DD`."""
    if not isinstance(value, str):
        return None, None
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return value, "day"
    if re.fullmatch(r"\d{4}-\d{2}", value):
        return f"{value}-01", "month"
    if re.fullmatch(r"\d{4}", value):
        return f"{value}-01-01", "year"
    return None, None


class _TelegramText(HTMLParser):
    """Telegram's HTML (b, i, a, code, blockquote) as the light markup the site renders."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.href: list[str | None] = []
        self.link_start: list[int] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in ("b", "strong"):
            self.out.append("**")
        elif tag == "a":
            self.href.append(dict(attrs).get("href"))
            self.link_start.append(len(self.out))
        elif tag == "br":
            self.out.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("b", "strong"):
            self.out.append("**")
        elif tag == "a" and self.link_start:
            start, href = self.link_start.pop(), self.href.pop()
            text = "".join(self.out[start:])
            del self.out[start:]
            self.out.append(f"[{text}]({href})" if href and href.startswith("http") else text)

    def handle_data(self, data: str) -> None:
        self.out.append(data)


def telegram_text(post_html: str) -> str:
    p = _TelegramText()
    p.feed(post_html)
    p.close()
    text = html.unescape("".join(p.out)).replace("****", "")
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _is_persian(text: str) -> bool:
    text = re.sub(r"\(https?://[^)]*\)", "", text)
    return len(re.findall(r"[؀-ۿ]", text)) > len(re.findall(r"[A-Za-z]", text))


def news_entries(rows: list[Row], channel: str | None) -> Imported:
    """The lab news timeline: one news-event entry per row, listed as the old /news/ listed it."""
    out = Imported()
    used: set[str] = set()
    for r in sorted(rows, key=lambda r: int(r["id"])):
        title = str(r.get("title") or "").strip()
        date, _ = _date(r.get("date"))
        listed = bool(date and r.get("url") and title and r.get("summary_fa"))
        base = f"{date or 'undated'}-{slugify(title, 50) or 'news'}"
        slug = base if base not in used else f"{base}-{r['id']}"
        used.add(slug)
        body: dict[str, dict[str, Any]] = {}
        if r.get("summary_fa"):
            body["fa"] = {"summary": str(r["summary_fa"]).strip()}
        if r.get("summary_en"):
            body["en"] = {"summary": str(r["summary_en"]).strip()}
        raw_ids = r.get("message_ids")
        message_ids: list[Any] = raw_ids if isinstance(raw_ids, list) else []
        facts = {
            "org": r.get("org"),
            "org_names": {"fa": ORG_FA[r["org"]]} if r.get("org") in ORG_FA else {},
            "news_kind": r.get("kind") or "other",
            "url": r.get("url"),
            "url_type": r.get("url_type") or "official",
            "links": _links(r.get("links")),
            "entities": r.get("entities") if isinstance(r.get("entities"), list) else [],
            "telegram": [u for m in message_ids if (u := telegram_url(channel, m))],
            "date_source": r.get("date_source"),
            "historical": r.get("source") == "historical-backfill",
        }
        out.entries.append(
            Entry(
                legacy_id=f"lab-news:{r['id']}",
                kind="news-event",
                slug=slug,
                title=title or str(r.get("url") or r["id"]),
                date=date,
                date_status=DATE_STATUS.get(str(r.get("date_status") or "verified")),
                facts=facts,
                body=body,
                listed=listed,
                search_text=" ".join(
                    str(x) for x in (title, r.get("org"), r.get("summary_fa")) if x
                ),
            )
        )
    out.url_map["/news/"] = "/news"
    return out


def classic_listed(c: Row) -> bool:
    return c.get("status") in CLASSIC_LISTED or (
        c.get("status") == "candidate" and bool(c.get("summary_fa")) and bool(c.get("problem_fa"))
    )


def classic_entries(
    candidates: list[Row],
    posts: list[Row],
    news: list[Entry],
    channel: str | None,
) -> Imported:
    """Every classic paper (D165): its researched sections and excerpts; rejected ones unlisted."""
    out = Imported()
    listed_slugs = {c["slug"] for c in candidates if classic_listed(c)}
    slug_by_classic_id = {
        str(c["classic_id"]): c["slug"]
        for c in candidates
        if c.get("classic_id") is not None and c["slug"] in listed_slugs
    }
    news_slug = {e.legacy_id.removeprefix("lab-news:"): e.slug for e in news if e.listed}
    post_by_id = {p.get("message_id"): p for p in posts}

    def ref(r: Row) -> dict[str, Any]:
        entry: dict[str, str] | None = None
        kind, key = r.get("kind"), str(r.get("ref"))
        if kind == "candidate" and key in listed_slugs:
            entry = {"kind": "paper", "slug": key}
        elif kind == "classic" and key in slug_by_classic_id:
            entry = {"kind": "paper", "slug": slug_by_classic_id[key]}
        elif kind == "lab_news" and key in news_slug:
            entry = {"kind": "timeline-item", "slug": news_slug[key]}
        url = (
            r.get("url") if isinstance(r.get("url"), str) and r["url"].startswith("http") else None
        )
        return {
            "title": str(r.get("title") or "").strip(),
            "year": r.get("year") if isinstance(r.get("year"), int) else None,
            "note": r.get("note_fa") or None,
            "entry": entry,
            "url": None if entry else url,
        }

    for c in sorted(candidates, key=lambda c: c["slug"]):
        slug = c["slug"]
        date, precision = _date(c.get("date"))
        if not date:
            date, precision = _date(str(c["year"]) if c.get("year") else None)
        fa: dict[str, Any] = {
            k: str(c[src]).strip() for k, src in CLASSIC_SECTIONS.items() if c.get(src)
        }
        excerpts = [
            {
                "location": e.get("location") or "",
                "original": e.get("original_en") or "",
                "translation": e.get("translation_fa") or "",
                "note": e.get("note_fa") or "",
            }
            for e in c.get("excerpts") or []
            if isinstance(e, dict)
        ]
        if excerpts:
            fa["excerpts"] = excerpts
        message_ids = [m for m in c.get("message_ids") or [] if isinstance(m, int)]
        # The classics posted before the candidate files held the text: their Telegram posts.
        if "overview" not in fa and "problem" not in fa:
            texts = [
                telegram_text(p["html"])
                for m in sorted(message_ids)
                if (p := post_by_id.get(m))
                and p.get("status") == "live"
                and isinstance(p.get("html"), str)
            ]
            parts = [x for x in texts if _is_persian(x)]
            if parts:
                fa["post"] = "\n\n".join(parts)
        sources = _links(c.get("further_reading"))
        pdf = c.get("pdf_url")
        if (
            isinstance(pdf, str)
            and pdf.startswith("http")
            and not any(s["url"] == pdf for s in sources)
        ):
            sources.append({"label": "Paper PDF", "url": pdf})
        authors: list[Any] = c.get("authors") or []
        url = c.get("url") or (f"https://doi.org/{c['doi']}" if c.get("doi") else c.get("pdf_url"))
        citations = (
            {
                "count": c["citation_count"],
                "as_of": c.get("citation_as_of"),
                "source": c.get("citation_source"),
            }
            if isinstance(c.get("citation_count"), int)
            else None
        )
        facts = {
            "classic": True,
            "classic_status": c.get("status"),
            "year": c.get("year"),
            "date_precision": precision,
            "date_source": c.get("date_source"),
            "authors": authors,
            "affiliations": c.get("affiliations") or [],
            "venue": c.get("venue"),
            "doi": c.get("doi"),
            "arxiv_id": c.get("arxiv_id"),
            "url": url,
            "citations": citations,
            "sources": sources,
            "telegram": [u for m in message_ids if (u := telegram_url(channel, m))],
            "posted_date": _date(str(c.get("posted_date") or "")[:10])[0]
            if c.get("status") == "posted"
            else None,
            "references": [ref(r) for r in c.get("references_seen") or [] if isinstance(r, dict)],
            "cited_by": [ref(r) for r in c.get("cited_by_seen") or [] if isinstance(r, dict)],
            "field": c.get("field"),
            "era": c.get("era"),
        }
        listed = classic_listed(c)
        text = " ".join(v for v in fa.values() if isinstance(v, str))
        out.entries.append(
            Entry(
                legacy_id=f"classic:{slug}",
                kind="paper",
                slug=slug,
                title=str(c.get("title") or slug).strip(),
                date=date,
                date_status="recorded" if date else None,
                facts=facts,
                body={"fa": fa} if fa else {},
                listed=listed,
                search_text=" ".join(
                    [str(c.get("title") or ""), " ".join(map(str, authors)), text]
                ),
            )
        )
        if listed:
            out.url_map[f"/papers/{slug}/"] = f"/reference/papers/{slug}"
    out.url_map["/wiki/topics/classic/"] = "/weekly-classic"
    return out


# ---------------------------------------------------------------- English (D169)


def text_key(text: str) -> str:
    """The cache key of one Persian text: its hash, so an edited source is translated again."""
    return hashlib.sha256(text.strip().encode()).hexdigest()[:24]


def persian_texts(entry: Entry) -> list[str]:
    """Every Persian text an entry shows that needs an English version."""
    if not entry.listed:
        return []
    fa = entry.body.get("fa", {})
    en = entry.body.get("en", {})
    out = [v for k, v in fa.items() if isinstance(v, str) and v.strip() and k not in en]
    out += [e["note"] for e in fa.get("excerpts", []) if isinstance(e, dict) and e.get("note")]
    for group in ("references", "cited_by"):
        out += [r["note"] for r in entry.facts.get(group, []) if r.get("note")]
    return out


def with_english(entry: Entry, translations: dict[str, str]) -> Entry:
    """The entry with its English text from the translation cache; texts not in it stay Persian."""
    fa = entry.body.get("fa")
    if not fa:
        return entry
    en: dict[str, Any] = dict(entry.body.get("en", {}))

    def tr(text: str) -> str | None:
        return translations.get(text_key(text))

    for k, v in fa.items():
        if isinstance(v, str) and k not in en and (t := tr(v)):
            en[k] = t
    # Excerpts' originals are English already; their notes come along once the text has English.
    if fa.get("excerpts") and any(isinstance(v, str) for v in en.values()):
        en["excerpts"] = [
            {**e, "translation": "", "note": (tr(e["note"]) or "") if e.get("note") else ""}
            for e in fa["excerpts"]
        ]
    facts = dict(entry.facts)
    for group in ("references", "cited_by"):
        if group in facts:
            facts[group] = [
                {**r, "note_en": tr(r["note"]) if r.get("note") else None} for r in facts[group]
            ]
    body = {**entry.body, "en": en} if en else entry.body
    english = " ".join(v for v in en.values() if isinstance(v, str))
    return replace(
        entry,
        body=body,
        facts=facts,
        search_text=f"{entry.search_text} {english}".strip(),
    )
