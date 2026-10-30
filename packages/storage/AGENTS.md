# @anr/storage

Object storage for raw pages, episode audio, published images and the TTS cache (D132): a private R2 bucket when one is set, a local directory in development.

- `objectStore(bucket, dir)` is the one entry point; `r2Client()` uses the apps' R2 token (never the backups bucket's, D149) and `ANR_S3_ENDPOINT` for a local stand-in.
- Buckets are never public: readers get `presignedUrl()` links valid for an hour.
- Keys are relative paths of lower-case letters, digits, dashes, dots and slashes.
- Tests run the AWS SDK against an in-process stand-in; no network.
