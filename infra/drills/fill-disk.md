# Drill: a filling disk

Fills a scratch volume, never Postgres's, until the disk with less free space is at 30 GB, so `DiskLow` (under 40 GB) fires and `DiskCritical` (under 20 GB) does not (D143, D153). It writes real data: on macOS Docker's VM disk is a sparse file on the host's disk, so only written blocks take the host's space, and Docker gives them back within seconds of the volume's removal.

## Before

- Ask the operator for `anr-prod`. The fill takes about 20 seconds a GB on a laptop; the script prints the free space it starts from.
- Nothing else should be writing much meanwhile: no backup, no release pull.

## Run

```bash
infra/drills/fill-disk.sh <project> [--prod] [GB free] [minutes]   # default 30 GB, hold 10 minutes
```

The script stops filling if the disk drops under 25 GB. Ctrl-C removes the volume at once. If the script itself dies: `docker rm -f anr-drill-fill && docker volume rm anr-drill-fill`.

## What should happen

| After | Signal |
| --- | --- |
| target reached | the disk's free space under 40 GB (Backups and disk), within a minute |
| about 6 min | `DiskLow` for that disk, in the ops chat |
| removal | the space is back; the alert resolves within 2 minutes |

## After

Postmortem from `docs/postmortems/template.md`. Check `infra/deploy.sh --check` passes again (it refuses under 20 GB free).
