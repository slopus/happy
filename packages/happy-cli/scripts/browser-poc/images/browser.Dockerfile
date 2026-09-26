FROM debian:bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium xvfb x11vnc novnc websockify socat python3 tini procps ca-certificates curl xdotool && rm -rf /var/lib/apt/lists/* && useradd -u 1000 -m -s /bin/sh browser && mkdir -p /run/abp /home/browser/profile && chown -R browser:browser /run/abp /home/browser
COPY scripts/browser-poc/images/browser-entrypoint.sh /usr/local/bin/browser-entrypoint
COPY scripts/browser-poc/images/instance-server.py /usr/local/bin/instance-server
COPY scripts/browser-poc/images/cdp-proxy.py /usr/local/bin/cdp-proxy
RUN chmod 755 /usr/local/bin/browser-entrypoint /usr/local/bin/instance-server /usr/local/bin/cdp-proxy
USER browser
EXPOSE 5900 6080 9223 9224
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/browser-entrypoint"]
