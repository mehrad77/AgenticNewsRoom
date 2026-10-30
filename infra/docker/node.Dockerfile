# One image per TypeScript app: docker build --build-arg APP=api -f infra/docker/node.Dockerfile .
# APP picks the c2patool stage below; `none` only names a valid stage, every build sets APP.
ARG APP=none

FROM node:24-slim AS base
WORKDIR /repo
# Install the pinned pnpm (packageManager) into the base layer, so containers never download it
# at start; `corepack enable` alone only installs a shim that fetches pnpm on first use.
COPY package.json ./
RUN corepack enable && corepack install

FROM base AS build
ARG APP
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter "@anr/${APP}..." run --if-present build

# c2patool signs episodes and images (D25, D120). Its releases have no arm64 Linux binary, so it is
# built from source; only the publisher's image takes it, the other apps' stage is empty, and
# BuildKit builds only the stage an image uses.
FROM rust:1.99.1-slim-bookworm@sha256:24707e70a4f1e23d9a7b25202ec43126d28a52294b96aad5c670df1fd1f1d400 AS c2patool-publisher
# renovate: datasource=crate depName=c2patool
ARG C2PATOOL_VERSION=0.27.22
# c2pa builds its own OpenSSL, which needs perl and make.
RUN apt-get update && apt-get install -y --no-install-recommends perl make pkg-config \
  && cargo install --locked --root /c2patool c2patool --version "${C2PATOOL_VERSION}"
FROM base AS c2patool-none
RUN mkdir -p /c2patool/bin
FROM c2patool-none AS c2patool-api
FROM c2patool-none AS c2patool-web
FROM c2patool-none AS c2patool-agents
FROM c2patool-${APP} AS c2patool

FROM base AS run
ARG APP
ENV APP=${APP} NODE_ENV=production
# The publisher mixes episodes (ffmpeg) and writes images' Photo Metadata (exiftool, D120).
RUN if [ "$APP" = publisher ]; then \
      apt-get update && apt-get install -y --no-install-recommends ffmpeg libimage-exiftool-perl \
      && rm -rf /var/lib/apt/lists/*; \
    fi
COPY --from=c2patool /c2patool/bin/ /usr/local/bin/
COPY --from=build /repo /repo
WORKDIR /repo/apps/${APP}
CMD ["pnpm", "start"]
