FROM node:22-bookworm@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7
RUN apt-get update -qq && apt-get install -y -qq bubblewrap sudo iptables iproute2 gcc libc6-dev python3 curl dbus systemd-resolved libnss-resolve nscd \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --prefix /test --no-audit --no-fund tsx@4.20.6
RUN groupadd abp-session && groupadd abp-work \
    && useradd -m -s /bin/bash agent && useradd -m -s /bin/bash agent-sbx && useradd -M -s /usr/sbin/nologin abp-proxy \
    && usermod -aG abp-session,abp-work,agent-sbx agent && usermod -aG abp-work agent-sbx \
    && chmod 700 /home/agent /home/agent-sbx \
    && mkdir -p /work /run/abp-mcp /run/abp /etc/abp /var/lib/abp /usr/local/libexec/abp /etc/aplus \
    && chown agent:abp-work /work && chmod 2770 /work \
    && chown agent:agent-sbx /run/abp-mcp && chmod 710 /run/abp-mcp \
    && chown root:abp-session /run/abp && chmod 750 /run/abp \
    && chmod 700 /etc/abp /var/lib/abp \
    && ln -s /usr/local/bin/node /usr/bin/node \
    && printf '%s\n' 'Defaults:agent env_reset,!use_pty' 'agent ALL=(agent-sbx) NOPASSWD: /usr/local/libexec/abp/claude-sbx-launch 0' > /etc/sudoers.d/abp \
    && chmod 440 /etc/sudoers.d/abp
WORKDIR /w/packages/happy-cli
ENV HAPPY_SANDBOX_LINUX_SMOKE=1
CMD ["/bin/bash", "scripts/sandbox-linux-smoke.sh"]
