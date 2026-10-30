"""Internal HTTP API. Only the agents worker's gate job calls it; it is never exposed publicly.

POST /verify runs the code checks on one story and stores every result as a Check (D79). 404 is
an unknown story; any other failure is a 5xx, which the gate stores as an error and holds.
"""

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from psycopg_pool import ConnectionPool

from anr_schemas.config.verify_request import VerifyRequest
from anr_schemas.config.verify_result import VerifyResult
from anr_verifier.db import Conn, create_pool
from anr_verifier.heartbeat import start_heartbeat
from anr_verifier.verify import StoryNotFound, verify

REPO = Path(__file__).resolve().parents[4]


def create_app(pool: ConnectionPool[Conn] | None = None, config_dir: Path | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if pool is None:
            url = os.environ.get("DATABASE_URL")
            if not url:
                raise RuntimeError("DATABASE_URL is not set; copy .env.example to .env")
            app.state.pool = create_pool(url)
        else:
            app.state.pool = pool
        app.state.pool.open()
        # Only the service's own run beats (D128); tests bring their own pool.
        stop_heartbeat = start_heartbeat(app.state.pool, "verifier") if pool is None else None
        yield
        if stop_heartbeat:
            stop_heartbeat()
        if pool is None:
            app.state.pool.close()

    app = FastAPI(title="ANR verifier", docs_url=None, redoc_url=None, lifespan=lifespan)
    configs = config_dir or Path(os.environ.get("ANR_CONFIG_DIR") or REPO / "config")

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok", "service": "verifier"}

    @app.post("/verify")
    def verify_story(body: VerifyRequest, request: Request) -> VerifyResult:
        try:
            checks = verify(
                request.app.state.pool, configs, str(body.newsroom_id), str(body.story_id)
            )
        except StoryNotFound as error:
            raise HTTPException(404, f"no story {error}") from error
        return VerifyResult.model_validate({"story_id": str(body.story_id), "checks": checks})

    return app


app = create_app()
