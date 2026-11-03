"""`legacy-import`: the old system's KB export into one newsroom's Reference (D166).

    uv run --env-file ../../.env legacy-import --newsroom ai --export DIR [--dry-run]

Reads `lab-news.jsonl`, `posts.jsonl` and `classic-candidates/*.json` from the export that
`pnpm kb:pull` writes in the old repo, and writes as the system role (DATABASE_SYSTEM_URL).
Idempotent on legacy ids: a rerun updates the entries it wrote before.
"""

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from .mapping import Entry, Imported, classic_entries, news_entries


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def read_classics(directory: Path) -> list[dict[str, Any]]:
    if not directory.is_dir():
        return []
    return [
        json.loads(f.read_text())
        for f in sorted(directory.glob("*.json"))
        if not f.name.startswith("_")
    ]


def load(export: Path, channel: str | None) -> Imported:
    news = news_entries(read_jsonl(export / "lab-news.jsonl"), channel)
    classics = classic_entries(
        read_classics(export / "classic-candidates"),
        read_jsonl(export / "posts.jsonl"),
        news.entries,
        channel,
    )
    return Imported(
        entries=news.entries + classics.entries,
        url_map={**news.url_map, **classics.url_map},
    )


def report(entries: list[Entry]) -> str:
    counts = Counter((e.kind, e.listed) for e in entries)
    lines = [
        f"{kind:<11} listed {counts[(kind, True)]:>4}  unlisted {counts[(kind, False)]:>4}"
        for kind in sorted({k for k, _ in counts})
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="legacy-import", description=__doc__.split("\n\n")[0])
    ap.add_argument("--newsroom", required=True, help="the target newsroom's slug")
    ap.add_argument("--export", required=True, type=Path, help="a legacy KB export directory")
    ap.add_argument("--telegram-channel", help="the old channel's username, for post links")
    ap.add_argument("--url-map", type=Path, help="write the old-path to new-path map here")
    ap.add_argument("--dry-run", action="store_true", help="count, write nothing")
    args = ap.parse_args(argv)

    imported = load(args.export, args.telegram_channel)
    print(report(imported.entries))
    if args.url_map:
        args.url_map.write_text(json.dumps(imported.url_map, indent=2, sort_keys=True) + "\n")
        print(f"url map: {len(imported.url_map)} paths -> {args.url_map}")
    if args.dry_run:
        return 0
    url = os.environ.get("DATABASE_SYSTEM_URL")
    if not url:
        print("DATABASE_SYSTEM_URL is not set; copy .env.example to .env", file=sys.stderr)
        return 2
    from .write import write

    inserted, updated = write(url, args.newsroom, imported.entries)
    print(f"written: {inserted} new, {updated} updated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
