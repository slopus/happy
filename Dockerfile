# Standalone happy-server: single container, no external dependencies
# Uses PGlite (embedded Postgres), local filesystem storage, no Redis

# Stage 1: install dependencies
FROM node:20 AS deps

RUN apt-get update && apt-get install -y python3 make g++ build-essential && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

COPY package.json yarn.lock ./
COPY scripts ./scripts

RUN mkdir -p packages/happy-app packages/happy-server packages/happy-cli packages/happy-agent packages/happy-wire

COPY packages/happy-app/package.json packages/happy-app/
COPY packages/happy-server/package.json packages/happy-server/
COPY packages/happy-cli/package.json packages/happy-cli/
COPY packages/happy-agent/package.json packages/happy-agent/
COPY packages/happy-wire/package.json packages/happy-wire/

# Workspace postinstall requirements
COPY packages/happy-app/patches packages/happy-app/patches
COPY packages/happy-server/prisma packages/happy-server/prisma
COPY packages/happy-cli/scripts packages/happy-cli/scripts
COPY packages/happy-cli/tools packages/happy-cli/tools

RUN SKIP_HAPPY_WIRE_BUILD=1 yarn install --frozen-lockfile --ignore-engines

# Stage 2: copy source and type-check
FROM deps AS builder

COPY packages/happy-wire ./packages/happy-wire
COPY packages/happy-server ./packages/happy-server

RUN yarn workspace @slopus/happy-wire build
RUN yarn workspace happy-server build

# Stage 3: runtime
FROM node:20-slim AS runner

WORKDIR /repo

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PGLITE_DIR=/data/pglite

COPY --from=builder /repo/node_modules /repo/node_modules
COPY --from=builder /repo/packages/happy-wire /repo/packages/happy-wire
COPY --from=builder /repo/packages/happy-server /repo/packages/happy-server

VOLUME /data
EXPOSE 3005

CMD ["sh", "-c", "node_modules/.bin/tsx packages/happy-server/sources/standalone.ts migrate && exec node_modules/.bin/tsx packages/happy-server/sources/standalone.ts serve"]
