FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
COPY apt-security.sh /tmp/apt-security.sh
RUN /tmp/apt-security.sh \
  && apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git python3 python3-pip xvfb x11vnc fluxbox procps \
  && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash rakazo \
  && /tmp/apt-security.sh --check && rm -f /tmp/apt-security.sh
WORKDIR /home/rakazo
USER rakazo
ENV DISPLAY=:1
CMD ["bash", "-lc", "Xvfb :1 -screen 0 1280x720x24 & sleep 0.5 && fluxbox & x11vnc -display :1 -forever -shared -nopw -listen 0.0.0.0 -rfbport 5900 & sleep infinity"]
