# The updater is the only service that gets the Docker CLI and the Docker socket, so it is built
# separately from the application image rather than adding root-equivalent tooling to api, worker,
# and web. It is also the only service the update never recreates, so its own image moves on the
# operator's schedule: `docker compose pull updater && docker compose up -d updater`.
FROM docker:27-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c AS dockercli

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose \
  /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-buildx \
  /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY infra/sandboxes/computer/apt-security.sh /tmp/apt-security.sh
RUN /tmp/apt-security.sh \
  && apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .pnpmfile.cjs ./
COPY patches patches
COPY packages/contracts packages/contracts
COPY packages/core packages/core
COPY packages/ui-tokens packages/ui-tokens
COPY packages/logging packages/logging
COPY infra/updater infra/updater
RUN corepack enable && pnpm install --frozen-lockfile --prod --filter "@rakazo/updater..."
RUN /tmp/apt-security.sh --check && rm -f /tmp/apt-security.sh
WORKDIR /app/infra/updater
ARG GIT_SHA
ENV GIT_SHA=$GIT_SHA
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
