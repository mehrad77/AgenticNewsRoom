"""Recorded responses instead of the web, for tests and fixture runs (ANR_INGESTION_REPLAY).

A directory with `web.json` mapping each URL to `{"file", "status", "headers"}`; any other URL
is a 404. Never fetches anything, so it needs no guard.
"""

import json
from dataclasses import dataclass, field
from pathlib import Path

import httpx


@dataclass
class ReplayWeb:
    root: Path
    routes: dict[str, dict[str, object]]
    requests: list[httpx.Request] = field(default_factory=list)

    @staticmethod
    def load(root: Path) -> "ReplayWeb":
        return ReplayWeb(root, json.loads((root / "web.json").read_text()))

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        route = self.routes.get(str(request.url))
        if route is None:
            return httpx.Response(404)
        raw_headers = route.get("headers")
        headers = (
            {str(k): str(v) for k, v in raw_headers.items()}
            if isinstance(raw_headers, dict)
            else {}
        )
        etag = headers.get("ETag")
        if etag and request.headers.get("if-none-match") == etag:
            return httpx.Response(304, headers=headers)
        content = (self.root / str(route["file"])).read_bytes() if route.get("file") else b""
        return httpx.Response(int(str(route.get("status", 200))), headers=headers, content=content)

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def urls(self) -> list[str]:
        return [str(r.url) for r in self.requests]
