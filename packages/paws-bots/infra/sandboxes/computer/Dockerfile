# The bot browser: chromium by default, or BROWSER=chrome (Google Chrome, amd64
# only) or BROWSER=brave (installed below).
ARG BROWSER=chromium
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
FROM ${DEBIAN_IMAGE} AS capture-builder
COPY apt-security.sh /tmp/apt-security.sh
RUN /tmp/apt-security.sh
RUN apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends ca-certificates \
  && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
    build-essential \
    libx11-dev \
    libxdamage-dev \
    libxext-dev \
    libxfixes-dev \
    libxtst-dev \
    libpng-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY xcapture.c .
RUN cc -O3 -fPIC -shared -Wall -Wextra -Werror -o librakazo-xcapture.so xcapture.c \
    -lX11 -lXext -lXdamage -lXfixes -lXtst -lpng

# Google's Linux package signing key, checked by fingerprint, for BROWSER=chrome.
# Only that key goes into the keyring apt trusts for the Google Chrome
# repository. Other builds never contact Google; the empty file they get is
# removed below.
FROM ${DEBIAN_IMAGE} AS chrome-keyring
ARG BROWSER
COPY apt-security.sh /tmp/apt-security.sh
RUN set -eux; \
  fingerprint=EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796; \
  : > /google-chrome.gpg; \
  [ "$BROWSER" = chrome ] || exit 0; \
  if [ "$(dpkg --print-architecture)" != amd64 ]; then \
    echo "Google publishes Chrome for amd64 only; build this platform with BROWSER=chromium" >&2; \
    exit 1; \
  fi; \
  /tmp/apt-security.sh; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
  export GNUPGHOME="$(mktemp -d)"; \
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub -o /tmp/google.pub; \
  gpg --batch --import /tmp/google.pub; \
  gpg --batch --export "$fingerprint" > /google-chrome.gpg; \
  gpg --batch --show-keys --with-colons /google-chrome.gpg | grep -qx "fpr:::::::::$fingerprint:"

FROM ${DEBIAN_IMAGE}
COPY apt-security.sh /tmp/apt-security.sh
RUN /tmp/apt-security.sh
# Dev tools let bots clone repos and fetch artifacts; containers run uid 1000
# with no privilege escalation, so nothing can be installed at runtime.
# Compilers stay in the builder stage; heavier toolchains are a separate call.
# Debian names fd-find's binary fdfind, so the image links it as fd.
ARG BROWSER
RUN apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends ca-certificates \
  && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
    xvfb \
    x11vnc \
    fluxbox \
    xterm \
    xdotool \
    wmctrl \
    x11-utils \
    x11-xserver-utils \
    imagemagick \
    novnc \
    websockify \
    python3 \
    libnss-wrapper \
    ca-certificates \
    procps \
    bash \
    $([ "$BROWSER" = chromium ] && echo chromium) \
    fonts-liberation \
    fonts-dejavu-core \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    fonts-thai-tlwg \
    locales \
    dbus-x11 \
    xdg-desktop-portal \
    xdg-desktop-portal-gtk \
    xdg-utils \
    curl \
    git \
    jq \
    openssh-client \
    unzip \
    xclip \
    xsel \
    poppler-utils \
    pandoc \
    python3-openpyxl \
    ripgrep \
    fd-find \
    file \
    sqlite3 \
    nftables \
  && rm -rf /var/lib/apt/lists/* \
  && pdftotext -v \
  && pdfinfo -v \
  && pandoc --version \
  && python3 -c 'import openpyxl; print(openpyxl.__version__)' \
  && rg --version \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && fd --version \
  && file --version \
  && sqlite3 --version \
  && if getent passwd node >/dev/null; then userdel node; fi \
  && groupadd --gid 1000 rakazo \
  && useradd --uid 1000 --gid rakazo --create-home --shell /bin/bash rakazo \
  && mkdir -p /etc/rakazo/fluxbox /etc/chromium/policies/managed /etc/brave/policies/managed /etc/opt/chrome/policies/managed \
  && printf '%s\n' '#!/bin/sh' 'exec xsetroot -solid "#111113" "$@"' > /usr/bin/fbsetbg \
  && chmod +x /usr/bin/fbsetbg \
  && ln -sfn /bin/true /usr/bin/xmessage
# Google Chrome or Brave replaces Chromium only when built with BROWSER=chrome
# or BROWSER=brave. The default build installs Chromium above, so this step does
# nothing for it. repo_add_once=false keeps Chrome's package from adding a
# second repository entry without the pinned key.
COPY --from=chrome-keyring /google-chrome.gpg /usr/share/keyrings/google-chrome.gpg
RUN set -eux; \
    [ "$BROWSER" = chrome ] || rm /usr/share/keyrings/google-chrome.gpg; \
    case "$BROWSER" in \
      chromium) ;; \
      chrome) \
        echo "deb [signed-by=/usr/share/keyrings/google-chrome.gpg arch=amd64] https://dl.google.com/linux/chrome/deb/ stable main" \
          > /etc/apt/sources.list.d/google-chrome.list; \
        echo 'repo_add_once="false"' > /etc/default/google-chrome; \
        apt-get update; \
        apt-get install -y --no-install-recommends google-chrome-stable; \
        rm -rf /var/lib/apt/lists/*; \
        google-chrome-stable --version ;; \
      brave) \
        keyring=/usr/share/keyrings/brave-browser-archive-keyring.gpg; \
        curl -fsSLo "$keyring" https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg; \
        echo "deb [signed-by=$keyring arch=$(dpkg --print-architecture)] https://brave-browser-apt-release.s3.brave.com/ stable main" \
          > /etc/apt/sources.list.d/brave-browser-release.list; \
        apt-get update; \
        apt-get install -y --no-install-recommends brave-browser; \
        rm -rf /var/lib/apt/lists/*; \
        mkdir -p /etc/brave/policies/managed; \
        printf '%s\n' '{' \
          '  "BraveRewardsDisabled": true,' \
          '  "BraveWalletDisabled": true,' \
          '  "BraveAIChatEnabled": false,' \
          '  "BraveVPNDisabled": true,' \
          '  "BraveNewsDisabled": true,' \
          '  "BraveTalkDisabled": true' \
          '}' > /etc/brave/policies/managed/rakazo.json ;; \
      *) echo "unsupported BROWSER: $BROWSER (use chromium, chrome or brave)" >&2; exit 1 ;; \
    esac
RUN ln -s "$(dpkg -L libnss-wrapper | grep '/libnss_wrapper.so$')" /usr/local/lib/libnss_wrapper.so
ARG TARGETARCH
ARG UV_VERSION=0.12.19
RUN set -eux; \
  case "$TARGETARCH" in \
    amd64) uv_arch=x86_64; uv_sha256=23bf5552d220e0842b65c862097b2ebaeba0064b74eda5e565e77fd25969d8c8 ;; \
    arm64) uv_arch=aarch64; uv_sha256=0804e9b164c64b6914182d5920c08551958a095986f10a3731056df701126436 ;; \
    *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  archive="$(mktemp)"; \
  curl -fsSL "https://releases.astral.sh/github/uv/releases/download/${UV_VERSION}/uv-${uv_arch}-unknown-linux-gnu.tar.gz" -o "$archive"; \
  echo "$uv_sha256  $archive" | sha256sum -c -; \
  tar -xzf "$archive" -C /usr/local/bin --strip-components=1 "uv-${uv_arch}-unknown-linux-gnu/uv" "uv-${uv_arch}-unknown-linux-gnu/uvx"; \
  rm -f "$archive"; \
  uv --version; \
  uvx --version
# Bookworm has no gh package; pin the upstream binary and verify sha256, same as uv.
ARG GH_VERSION=2.100.0
RUN set -eux; \
  case "$TARGETARCH" in \
    amd64) gh_arch=amd64; gh_sha256=e4d4bb4498e8d007abe545b6568926793ace1b6447da598294a610018cb164be ;; \
    arm64) gh_arch=arm64; gh_sha256=ea4e7a581a32ccad6cc7923cb1576ac5859ba4b9a16ab22eb8f8a96e78e2e961 ;; \
    *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  archive="$(mktemp)"; \
  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${gh_arch}.tar.gz" -o "$archive"; \
  echo "$gh_sha256  $archive" | sha256sum -c -; \
  tar -xzf "$archive" -C /usr/local/bin --strip-components=2 "gh_${GH_VERSION}_linux_${gh_arch}/bin/gh"; \
  rm -f "$archive"; \
  gh --version
# The page browser drives the visible Chromium through chrome-use, pinned and checked by sha256.
COPY --chmod=755 install-chrome-use.sh /tmp/install-chrome-use.sh
RUN /tmp/install-chrome-use.sh /usr/local/bin && rm /tmp/install-chrome-use.sh \
  && mkdir -p /usr/local/lib/rakazo
ENV DISPLAY=:1
ENV HOME=/home/rakazo
# Keep UTF-8 explicit (an empty LANG broke non-ASCII file handling in the
# file chooser for CJK-market users) and generate zh_CN.UTF-8 so deployments
# that override the computer environment can opt in to a Chinese locale.
RUN sed -i 's/^# zh_CN.UTF-8 UTF-8/zh_CN.UTF-8 UTF-8/' /etc/locale.gen && locale-gen
ENV LANG=C.UTF-8
ENV UV_TOOL_DIR=/home/rakazo/.local/share/uv/tools \
    UV_TOOL_BIN_DIR=/home/rakazo/.local/bin \
    UV_PYTHON_INSTALL_DIR=/home/rakazo/.local/share/uv/python
WORKDIR /home/rakazo
# --chmod normalizes modes: a restrictive host umask (e.g. 077 on hardened hosts) would
# otherwise leave these files unreadable to USER 1000 at runtime.
COPY --chmod=755 start.sh /usr/local/bin/rakazo-computer
COPY --chmod=644 user-env.sh /usr/local/lib/rakazo-user-env.sh
COPY --chmod=755 control.py /usr/local/bin/rakazo-computer-control
# Tells the supervisor this control service accepts scrolls aimed at a point and sideways
# scrolls; it sends those to older images through its fallback instead.
LABEL rakazo.control.aimedScroll="1"
COPY --from=capture-builder /build/librakazo-xcapture.so /usr/local/lib/librakazo-xcapture.so
COPY --chmod=755 rakazo-browser /usr/local/bin/rakazo-browser
COPY --chmod=755 rakazo-focus-or-launch /usr/local/bin/rakazo-focus-or-launch
COPY --chmod=755 rakazo-page-browser /usr/local/bin/rakazo-page-browser
COPY --chmod=644 page_secrets.py /usr/local/lib/rakazo/page_secrets.py
COPY --chmod=644 rakazo-browser.desktop /usr/share/applications/rakazo-browser.desktop
# Rakazo keeps credentials itself; the browser's save prompts would cover pages.
# Pop-ups open: one a page opens after making a report would be blocked unseen.
COPY --chmod=644 browser-policy.json /etc/chromium/policies/managed/rakazo-browser.json
COPY --chmod=644 browser-policy.json /etc/brave/policies/managed/rakazo-browser.json
COPY --chmod=644 browser-policy.json /etc/opt/chrome/policies/managed/rakazo-browser.json
COPY --chmod=644 fluxbox.init /etc/rakazo/fluxbox/init
COPY --chmod=644 fluxbox.apps /etc/rakazo/fluxbox/apps
COPY --chmod=644 fluxbox.menu /etc/rakazo/fluxbox/menu
COPY --chmod=644 embed.html /usr/share/novnc/embed.html
COPY --chmod=644 clipboard-bridge.js /usr/share/novnc/clipboard-bridge.js
COPY --chmod=644 mobile-keyboard.js /usr/share/novnc/mobile-keyboard.js
# Login shells source this after Debian's /etc/profile resets PATH. The home
# volume hides /etc/skel, so ~/.local/bin has to be restored from the image.
COPY --chmod=644 rakazo-local-bin.sh /etc/profile.d/rakazo-local-bin.sh
# Strip CR so shebangs work even if the build context came from a CRLF checkout.
RUN ldconfig \
  && sed -i 's/\r$//' /usr/local/bin/rakazo-computer /usr/local/lib/rakazo-user-env.sh /usr/local/bin/rakazo-computer-control /usr/local/bin/rakazo-browser /usr/local/bin/rakazo-focus-or-launch /usr/local/bin/rakazo-page-browser \
    /usr/local/lib/rakazo/page_secrets.py \
    /etc/rakazo/fluxbox/init /etc/rakazo/fluxbox/apps /etc/rakazo/fluxbox/menu \
    /etc/profile.d/rakazo-local-bin.sh
# Agent-authored scripts often use the unversioned name. Keep it on the installed Python 3.
RUN ln -s /usr/bin/python3 /usr/local/bin/python \
  && python -c 'import sys; assert sys.version_info.major == 3'
RUN /tmp/apt-security.sh --check && rm -f /tmp/apt-security.sh
EXPOSE 7070 6080 6081 6082 6083 6084 6085 6086 6087 6088 6089 6090 6091 6092 6093 6094 6095
# Docker exec does not inherit PID 1's exports, so every process gets the same
# identity lookup. Startup creates these private files for the effective UID/GID.
ENV LD_PRELOAD=/usr/local/lib/libnss_wrapper.so \
    NSS_WRAPPER_PASSWD=/tmp/rakazo-nss/passwd \
    NSS_WRAPPER_GROUP=/tmp/rakazo-nss/group
USER 1000:1000
# Start Bash without the wrapper; user-env enables it once both files exist.
CMD ["/usr/bin/env", "-u", "LD_PRELOAD", "/usr/local/bin/rakazo-computer"]
