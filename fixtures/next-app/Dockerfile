# syntax=docker/dockerfile:1
#
# Three stages so the image that runs carries neither the sources nor the build toolchain.
# The kit builds this file; it does not template it — the Dockerfile belongs to the project
# (docs/multi-stack-plan.md §5).

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The commit, passed by the pipeline as a build argument. next.config inlines it into the
# build, and /api/health reports it: `verify` compares that against the SHA it just deployed,
# so a stale container cannot pass as a successful release.
ARG GIT_SHA=dev
ARG NEXT_PUBLIC_FIXTURE_LABEL=
ENV GIT_SHA=$GIT_SHA \
    NEXT_PUBLIC_FIXTURE_LABEL=$NEXT_PUBLIC_FIXTURE_LABEL \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# `output: standalone` writes server.js next to only the packages it imports; static and
# public are served beside it.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static

# Next writes its prerender cache here while serving, and standalone does not create the
# directory. The image runs as `node`, so without this every incremental render fails with
# EACCES — the page still renders, so nothing looks broken, and the cache never fills.
RUN mkdir -p .next/cache && chown -R node:node .next

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
