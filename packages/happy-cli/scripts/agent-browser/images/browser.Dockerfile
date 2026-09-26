# Production browser image (abp-stack build): one per profile, never published.
# Differences from the PoC image: Chromium keeps its own sandbox (the container
# runs under /etc/abp/seccomp-chromium.json), no noVNC/websockify, no fixture
# host rules, dedicated uid 10871 reserved on the host (abp-browser) instead of 1000.
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
FROM ${DEBIAN_IMAGE}
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium xvfb x11vnc socat python3 tini procps ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10871 browser && useradd --uid 10871 --gid 10871 --create-home --shell /usr/sbin/nologin browser \
    && mkdir -p /run/abp /home/browser/profile && chown -R browser:browser /run/abp /home/browser
COPY browser-entrypoint.sh /usr/local/bin/browser-entrypoint
COPY instance-server.py /usr/local/bin/instance-server
COPY cdp-proxy.py /usr/local/bin/cdp-proxy
RUN chmod 755 /usr/local/bin/browser-entrypoint /usr/local/bin/instance-server /usr/local/bin/cdp-proxy
USER browser
EXPOSE 5900 9223 9224
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/browser-entrypoint"]
