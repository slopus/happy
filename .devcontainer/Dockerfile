# FROM node:25
FROM ubuntu:25.10

ARG TZ
ENV TZ="$TZ"

ARG CLAUDE_CODE_VERSION=latest

# Installs a TON of stufF:
RUN apt-get update && apt-get install -y npm

# Stolen from the nodejs/docker/node Dockerfile:
# RUN groupadd --gid 1000 node \
#   && useradd --uid 1000 --gid node --shell /bin/bash --create-home node

# Install basic development tools and iptables/ipset
RUN apt-get install -y --no-install-recommends \
  less \
  git \
  procps \
  sudo \
  fzf \
  zsh \
  man-db \
  unzip \
  gnupg2 \
  gh \
  iptables \
  ipset \
  iproute2 \
  dnsutils \
  aggregate \
  jq \
  nano \
  vim

  # && apt-get clean && rm -rf /var/lib/apt/lists/*

# ENV MYUSER=node
ENV MYUSER=ubuntu

# Ensure default node user has access to /usr/local/share
RUN mkdir -p /usr/local/share/npm-global && \
  chown -R $MYUSER:$MYUSER /usr/local/share

ARG USERNAME=$MYUSER

# Persist bash history.
RUN SNIPPET="export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  && mkdir /commandhistory \
  && touch /commandhistory/.bash_history \
  && chown -R $USERNAME /commandhistory

# Set `DEVCONTAINER` environment variable to help with orientation
ENV DEVCONTAINER=true

# Create workspace and config directories and set permissions
RUN mkdir -p /workspace /home/$MYUSER/.claude && \
  chown -R $MYUSER:$MYUSER /workspace /home/$MYUSER/.claude

WORKDIR /workspace

RUN apt-get install -y wget curl
ARG GIT_DELTA_VERSION=0.18.2
RUN ARCH=$(dpkg --print-architecture) && \
  wget "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  sudo dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

# Set up non-root user
USER $MYUSER

# Install global packages
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

# Set the default shell to zsh rather than sh
ENV SHELL=/bin/zsh

# Set the default editor and visual
ENV EDITOR=nano
ENV VISUAL=nano

# Default powerline10k theme
ARG ZSH_IN_DOCKER_VERSION=1.2.0
RUN sh -c "$(wget -O- https://github.com/deluan/zsh-in-docker/releases/download/v${ZSH_IN_DOCKER_VERSION}/zsh-in-docker.sh)" -- \
  -p git \
  -p fzf \
  -a "source /usr/share/doc/fzf/examples/key-bindings.zsh" \
  -a "source /usr/share/doc/fzf/examples/completion.zsh" \
  -a "export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  -x

# Install Claude
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}


# Copy and set up firewall script
COPY init-firewall.sh /usr/local/bin/
USER root
RUN chmod +x /usr/local/bin/init-firewall.sh && \
  echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/node-firewall && \
  chmod 0440 /etc/sudoers.d/node-firewall
USER $MYUSER

# Install Dependencies
USER root
# RUN apt-get update
RUN apt-get install -y maven time

# RUN apt-get install -y cargo
# RUN cargo install rustfmt-nightly

RUN apt-get install rustup
RUN rustup toolchain install stable

# RUN apt-get install -y golang
# RUN go install github.com/steveyegge/beads/cmd/bd@latest

ENV IS_SANDBOX=1
ENV PATH="$PATH:/root/go/bin:/root/.cargo/bin"

# ADD --chown=node:node dot-claude-init /home/node/.claude/
# Share the config directory from the host:
# VOLUME [ "/home/node/.claude" ]
# dot-claude /home/node/.claude/

# Hobble what Claude can install:
# RUN apt-get clean && rm -rf /var/lib/apt/lists/*

USER $MYUSER
