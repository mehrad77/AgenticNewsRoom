# tools/load

k6 load test of the reader sites (D142): `reader.js` requests home pages, publications, search, ninjs twins and podcast feeds at a constant rate, with thresholds of no errors, p95 under 500 ms and no request k6 could not start in time. `run.sh` runs it in a pinned k6 container on the project's networks, against its Caddy (the origin, not Cloudflare), and sends the results to its Grafana over OTLP (the Load tests dashboard).

```bash
tools/load/run.sh dev                         # dev's web (pnpm dev) and telemetry stack
tools/load/run.sh anr-prod iranian.eu.org     # prod's origin; ask the operator first
KINDS=home,search,feed DURATION=30s tools/load/run.sh dev   # where nothing is published yet
```

- Hosts and podcast feeds come from `config/newsrooms`; publications from the sites' home pages, so it needs no fixture data. A kind with nothing to request fails the run rather than passing untested.
- Metrics carry `kind` and `host`, never the URL: one series per kind and site.
- Run it before a release that touches the web app or its queries.
