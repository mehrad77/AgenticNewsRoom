"""Where raw pages go: object storage off the server (R2) in production, a local directory while
ANR runs on the laptop (D53). Keys are content-addressed, so storing the same bytes twice is a
no-op and a key always names exactly one snapshot (D55)."""

import hashlib
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client


def raw_key(data: bytes) -> str:
    digest = hashlib.sha256(data).hexdigest()
    return f"raw/{digest[:2]}/{digest}"


class RawStore(Protocol):
    def put(self, data: bytes, content_type: str) -> str:
        """Stores `data` and returns its key."""
        ...


class LocalRawStore:
    def __init__(self, root: Path) -> None:
        self.root = root

    def put(self, data: bytes, content_type: str) -> str:
        key = raw_key(data)
        path = self.root / key
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            # Write then rename, so a crash never leaves a truncated snapshot under the key.
            # A temp name per writer: two threads storing the same bytes never share one.
            tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
            tmp.write_bytes(data)
            tmp.replace(path)
        return key


class S3RawStore:
    """R2 (or any S3-compatible store). Objects are never overwritten: same key, same bytes."""

    def __init__(self, client: "S3Client", bucket: str) -> None:
        self.client = client
        self.bucket = bucket

    def put(self, data: bytes, content_type: str) -> str:
        key = raw_key(data)
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)
        return key
