# One file, three images. They share the same dependency layer, so building all
# three costs barely more than building one.
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

# --- dependencies -----------------------------------------------------------
# Only the manifests are copied first, so a source change does not invalidate the
# install layer.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/jobs/package.json packages/jobs/
COPY packages/processing/package.json packages/processing/
COPY packages/recorder/package.json packages/recorder/
COPY packages/storage/package.json packages/storage/
RUN pnpm install --frozen-lockfile

FROM deps AS source
COPY . .

# --- api --------------------------------------------------------------------
FROM source AS api
ENV NODE_ENV=production
EXPOSE 3000
# Node runs the TypeScript directly, so there is no build step and nothing that
# can be stale relative to the source in the image.
CMD ["node", "apps/api/src/server.ts"]

# --- worker -----------------------------------------------------------------
FROM source AS worker
# The one image that needs an encoder.
RUN apk add --no-cache ffmpeg
ENV NODE_ENV=production
CMD ["node", "apps/worker/src/index.ts"]

# --- migrations -------------------------------------------------------------
# Run once on startup, before the API is allowed to accept traffic.
FROM source AS migrate
CMD ["node", "packages/db/src/migrate.ts"]

# --- web --------------------------------------------------------------------
FROM source AS web-build
RUN pnpm --filter @osprey/web build

FROM caddy:2-alpine AS web
COPY --from=web-build /app/apps/web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
