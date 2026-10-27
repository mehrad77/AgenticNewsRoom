from pathlib import Path

from conftest import Newsroom, anr_test_url
from fastapi.testclient import TestClient

from anr_ingestion.app import app, create_app
from anr_ingestion.db import create_pool
from anr_ingestion.net import Fetcher
from anr_ingestion.pipeline import Ingestor
from anr_ingestion.rawstore import LocalRawStore


def test_healthz() -> None:
    response = TestClient(app).get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "ingestion"}


def test_endpoints_map_outcomes_to_statuses(
    fetcher: Fetcher, newsroom: Newsroom, tmp_path: Path
) -> None:
    def make() -> Ingestor:
        # The app closes its pool on shutdown, so it gets one of its own.
        pool = create_pool(anr_test_url("DATABASE_URL"))
        pool.open()
        return Ingestor(pool, fetcher, LocalRawStore(tmp_path))

    with TestClient(create_app(make)) as client:
        ok = client.post(
            "/ingest", json={"newsroom_id": newsroom.id, "source_id": newsroom.sources["lab"]}
        )
        assert ok.status_code == 200
        body = ok.json()
        assert len(body["new_leads"]) == 2 and body["not_modified"] is False
        assert body["errors"][0]["url"] == "https://openai.com/index/gone/"

        refused = client.post(
            "/ingest", json={"newsroom_id": newsroom.id, "source_id": newsroom.sources["unchecked"]}
        )
        assert refused.status_code == 422 and "terms_checked" in refused.json()["detail"]

        missing = client.post(
            "/ingest",
            json={"newsroom_id": newsroom.id, "source_id": "00000000-0000-0000-0000-000000000000"},
        )
        assert missing.status_code == 404

        invalid = client.post("/ingest", json={"newsroom_id": "not-a-uuid"})
        assert invalid.status_code == 422  # the schema from packages/schemas

        unknown_run = client.post(
            "/request-source",
            json={
                "newsroom_id": newsroom.id,
                "agent_run_id": "00000000-0000-0000-0000-000000000000",
                "url": "https://unknown.example/report",
            },
        )
        assert unknown_run.status_code == 404
