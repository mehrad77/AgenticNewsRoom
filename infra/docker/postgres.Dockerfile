# Postgres 17 with pgBackRest and the platform's role bootstrap. Same image in dev and production.
FROM postgres:17
RUN apt-get update \
  && apt-get install -y --no-install-recommends pgbackrest ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY infra/postgres/roles.sql /anr/roles.sql
COPY --chmod=755 infra/postgres/anr-roles.sh /usr/local/bin/anr-roles
COPY --chmod=755 infra/postgres/initdb/ /docker-entrypoint-initdb.d/
