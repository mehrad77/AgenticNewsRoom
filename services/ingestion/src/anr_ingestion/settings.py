"""The service's settings, all from the environment (.env.example lists them)."""

import os
from dataclasses import dataclass
from pathlib import Path

from anr_ingestion.rawstore import LocalRawStore, RawStore, S3RawStore

REPO = Path(__file__).resolve().parents[4]


@dataclass(frozen=True)
class Settings:
    database_url: str
    root_domain: str
    raw_dir: Path
    raw_bucket: str | None
    replay: Path | None
    """A fixtures directory served instead of the web (tests and fixture runs only)."""

    @staticmethod
    def from_env() -> "Settings":
        url = os.environ.get("DATABASE_URL")
        if not url:
            raise RuntimeError("DATABASE_URL is not set; copy .env.example to .env")
        return Settings(
            database_url=url,
            root_domain=os.environ.get("ANR_ROOT_DOMAIN") or "localhost",
            raw_dir=Path(os.environ.get("ANR_RAW_DIR") or REPO / ".data" / "raw"),
            raw_bucket=os.environ.get("ANR_RAW_BUCKET") or None,
            replay=Path(os.environ["ANR_INGESTION_REPLAY"])
            if os.environ.get("ANR_INGESTION_REPLAY")
            else None,
        )

    @property
    def user_agent(self) -> str:
        return f"ANR-Ingestion/0.1 (+https://{self.root_domain}/)"

    def raw_store(self) -> RawStore:
        """The raw bucket when one is set (production, D132), else a local directory (D55).

        The apps' R2 token, never the backups bucket's (D149); ANR_S3_ENDPOINT names a stand-in.
        """
        if not self.raw_bucket:
            return LocalRawStore(self.raw_dir)
        import boto3
        from botocore.config import Config

        account = os.environ.get("R2_ACCOUNT_ID")
        client = boto3.client(
            "s3",
            endpoint_url=os.environ.get("ANR_S3_ENDPOINT")
            or f"https://{account}.r2.cloudflarestorage.com",
            aws_access_key_id=os.environ.get("R2_ACCESS_KEY_ID"),
            aws_secret_access_key=os.environ.get("R2_SECRET_ACCESS_KEY"),
            region_name="auto",
            config=Config(s3={"addressing_style": "path"}),
        )
        return S3RawStore(client, self.raw_bucket)
