#!/usr/bin/env bash
# Run once by the postgres image on an empty volume. Later changes: `anr-roles` (see that script).
set -euo pipefail
anr-roles
