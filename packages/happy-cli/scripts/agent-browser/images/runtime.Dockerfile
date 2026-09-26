# Production Browser Runtime image (abp-stack build). Build context is a staging
# directory holding only runtime.mjs (bundled runtimeMain), the S2 entrypoint and
# this file, so the image content is exactly what is pinned by its digest.
# Base images are pinned by digest; override for another architecture or a
# security update, then ship the result through abp-stack upgrade.
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

# Pinned noVNC client for the Runtime viewer at /viewer/ (D2), as in the viewer stream's image.
FROM ${DEBIAN_IMAGE} AS novnc
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends novnc=1:1.3.0-1 && rm -rf /var/lib/apt/lists/*

FROM ${NODE_IMAGE}
# uid/gid 10870: host account abp-runtime reserves it, so no login user owns the state files.
# Production starts the container as root with only SETUID/SETGID; node reads the
# root-only config, binds the /run/abp sockets and drops to ABP_RUNTIME_UID/GID.
RUN groupadd --system --gid 10870 abp && useradd --system --uid 10870 --gid 10870 --no-create-home --shell /usr/sbin/nologin abp \
    && mkdir -p /var/lib/abp /run/abp && chown abp:abp /var/lib/abp /run/abp
COPY --from=novnc /usr/share/novnc /usr/share/novnc
COPY runtime-entrypoint.sh /usr/local/bin/abp-runtime-entrypoint
COPY runtime.mjs /app/runtime.mjs
RUN chmod 755 /usr/local/bin/abp-runtime-entrypoint && chmod 644 /app/runtime.mjs
ENV ABP_RUNTIME_UID=10870 ABP_RUNTIME_GID=10870 NODE_ENV=production
USER abp
WORKDIR /app
ENTRYPOINT ["/usr/local/bin/abp-runtime-entrypoint"]
