# One image per TypeScript app: docker build --build-arg APP=api -f infra/docker/node.Dockerfile .
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

FROM base AS run
ARG APP
ENV APP=${APP} NODE_ENV=production
# The publisher mixes episodes (ffmpeg) and writes images' Photo Metadata (exiftool, D120).
RUN if [ "$APP" = publisher ]; then \
      apt-get update && apt-get install -y --no-install-recommends ffmpeg libimage-exiftool-perl \
      && rm -rf /var/lib/apt/lists/*; \
    fi
COPY --from=build /repo /repo
WORKDIR /repo/apps/${APP}
CMD ["pnpm", "start"]
