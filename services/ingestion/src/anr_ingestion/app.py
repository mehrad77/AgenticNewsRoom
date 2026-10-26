"""Internal HTTP API. Only TypeScript pg-boss jobs call it; it is never exposed publicly."""

from fastapi import FastAPI

app = FastAPI(title="ANR ingestion", docs_url=None, redoc_url=None)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "service": "ingestion"}
