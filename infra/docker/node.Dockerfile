# One image per TypeScript app: docker build --build-arg APP=api -f infra/docker/node.Dockerfile .
FROM node:24-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
ARG APP
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter "@anr/${APP}..." run --if-present build

FROM base AS run
ARG APP
ENV APP=${APP} NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/${APP}
CMD ["pnpm", "start"]
