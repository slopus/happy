
USER=ubuntu

TAG := $(shell cat project_name.txt)

ifeq ($(strip $(TAG)),)
    $(error TAG must be set (from project_name.txt) and not empty!)
endif

# Get or create workspace name
# Go up ../ or ../../ until git remote does NOT include claude_template
# Use directory name, unless it's "workspace", then use git remote name
REPONAME := $(shell \
	if [ -f ./home/workspace_name.txt ]; then \
		cat ./home/workspace_name.txt; \
	else \
		PARENT_REMOTE=$$(cd .. && git remote get-url origin 2>/dev/null); \
		if echo "$$PARENT_REMOTE" | grep -iq "claude_template"; then \
			TOPLEVEL=$$(cd ../.. && git rev-parse --show-toplevel 2>/dev/null); \
		else \
			TOPLEVEL=$$(cd .. && git rev-parse --show-toplevel 2>/dev/null); \
		fi; \
		DIRNAME=$$(basename "$$TOPLEVEL"); \
		if [ "$$DIRNAME" = "workspace" ]; then \
			git -C "$$TOPLEVEL" remote get-url origin 2>/dev/null | sed -E 's|.*/([^/]+)\.git$$|\1|' | tee ./home/workspace_name.txt; \
		else \
			echo "$$DIRNAME" | tee ./home/workspace_name.txt; \
		fi; \
	fi)


# Get or create realhostname
REALHOSTNAME := $(shell if [ -f ./home/realhostname.txt ]; then cat ./home/realhostname.txt; else hostname | tee ./home/realhostname.txt; fi)

# Reserve a unique, per-repo container index (N) on this host. 
SLOT := $(shell \
	if [ -f slot.txt ]; then \
		cat slot.txt; \
	else \
		rep="$(REPONAME)"; n=1; \
		while true; do \
		   f="/tmp/container-$$rep-$$n.token"; \
		   if ( set -o noclobber; : > "$$f" ) 2>/dev/null; \
		     then echo $$n; break; \
			 else n=$$((n+1)); \
		   fi; \
		done; \
		echo $$n > slot.txt; \
	fi)

CONTAINER_HOSTNAME := $(REALHOSTNAME)-$(SLOT)

FULLTAG := $(TAG)-$(SLOT)

# Compute dynamic workspace directory name
WORKDIR := /$(REPONAME)-$(REALHOSTNAME)

OS := $(shell uname)

ifeq ($(OS),Darwin)
    CONTAINER=docker
else ifeq ($(OS),Linux)
    CONTAINER=podman
else
    CONTAINER= echo Unsupported_OS && exit 1
endif

GOCLAUDE= claude --dangerously-skip-permissions --continue

# Always invoke claude from the same space so we don't confuse our claude.json workspace config.
# Now uses the dynamically computed WORKDIR instead of hardcoded /workspace
CLAUDEWORK= $(WORKDIR)

# `make CACHEBUST="$(date +%s)" build` to force rebuild.
build: Dockerfile
	$(CONTAINER) build -t $(FULLTAG) --build-arg CACHEBUST=$(CACHEBUST) --build-arg WORKDIR=$(WORKDIR) .

run:
	$(CONTAINER) run -it --rm -u $(USER) --hostname $(CONTAINER_HOSTNAME) \
		-v `pwd`/home:/home/$(USER) \
		-v `pwd`/..:$(WORKDIR) \
		$(FULLTAG) bash

root:
	$(CONTAINER) run -it --rm -u root --hostname $(CONTAINER_HOSTNAME) \
		-v `pwd`/home:/root \
		-v `pwd`/..:$(WORKDIR) \
		$(FULLTAG) bash

AGENT_LAYERS = Dockerfile.claude Dockerfile.copilot
# Dockerfile.gemini

# Remove Dockerfile.rust if we are not using rust or minibeads:
OPTIONAL_DOCKER_LAYERS = Dockerfile.rust
Dockerfile: Dockerfile.*
	cat Dockerfile.prefix $(AGENT_LAYERS) $(OPTIONAL_DOCKER_LAYERS) Dockerfile.project Dockerfile.postfix > Dockerfile

# TODO: need a way to pass this into happy on the CLI.
# It can take an MCP action to change it, but that's lame and wasteful.
.session_title.txt:
	echo $(TAG)-`hostname` > $@

claude:
	cd "$(CLAUDEWORK)" && $(GOCLAUDE)

# Use my tweaked version of happy if it's available
happy: .session_title.txt
	TITLE=`cat $^` && cd .. && \
	cd "$(CLAUDEWORK)" && happy $(GOCLAUDE)
#	hits=$$(happy -h | grep '\-\-name'); \
	cd "$(CLAUDEWORK)" && \
	if [ -z "$$hits" ]; then \
	  happy --name "$$TITLE" $(GOCLAUDE); else \
	  happy $(GOCLAUDE) "Tell happy to change the title to $$TITLE"; \
	fi

# Usually from outside the container, to pass it in:
install-pat: home/.github/PAT.txt
home/.github/PAT.txt:
	mkdir home/.github
	@if ! [ -z "$(GITHUB_PERSONAL_ACCESS_TOKEN)" ]; then \
		echo "$(GITHUB_PERSONAL_ACCESS_TOKEN)" > home/.github/PAT.txt; \
	elif [ -f ~/.github/PAT.txt ]; then \
		cp ~/.github/PAT.txt home/.github/PAT.txt; \
	else \
		echo "Error: GITHUB_PERSONAL_ACCESS_TOKEN not set and no ~/.github/PAT.txt file found." ; \
		exit 1; \
	fi

# Still need to manually add this key to GitHub as a deploy key for the repo.
install-ssh-deploy-key: home/.ssh/id_rsa.pub
home/.ssh/id_rsa.pub:
	ssh-keygen -t rsa -b 4096 -f home/.ssh/id_rsa -N "" -C "deploy-key-`hostname`"

# From inside the container:
claude-github:
	cd "$(CLAUDEWORK)" && \
	claude mcp remove github || \
	claude mcp add --transport http github https://api.githubcopilot.com/mcp \
          -H "Authorization: Bearer $(GITHUB_PERSONAL_ACCESS_TOKEN)"

gh-auth:
	cat "$(HOME)/.github/PAT.txt" |  gh auth login --with-token

# From inside the container:
claude-beads:
	cd "$(CLAUDEWORK)" && claude plugin marketplace add steveyegge/beads
	cd "$(CLAUDEWORK)" && claude plugin install beads

outside-setup: install-pat

inside-setup: claude-github claude-beads install-ssh-deploy-key gh-auth

# Pull and rebase any upstream changes to the central config on the main branch.
pull-main:
	git diff --exit-code || \
	(echo "Please commit or stash your changes before pulling." && exit 1) && \
	BRANCH=`git branch --show-current` && \
	git checkout main && \
	git pull origin main && \
	git checkout $$BRANCH && \
	git merge main

commit-to-main:
	./commit_to_main.sh

# Get out of the way so work in this repo doesn't mess with the scripts we're
# running to drive Claude.
#
# Copy .devcontainer to $HOME if we're under /workspace, then switch to it
rsync:
	@if echo "$(PWD)" | grep -q "^/workspace"; then \
		echo "Detected /workspace directory, copying to $$HOME/devcontainer_clone..."; \
		mkdir -p "$$HOME/devcontainer_clone"; \
		rsync -av --no-owner --no-group --exclude='home/' "$(PWD)/" "$$HOME/devcontainer_clone/"; \
		echo "Switching to $$HOME/devcontainer_clone"; \
		cd "$$HOME/devcontainer_clone" && exec bash; \
	else \
		echo "Not under /workspace directory, no action taken."; \
		echo "Current directory: $(PWD)"; \
	fi

# Bidirectional sync using unison
sync:
	@if echo "$(PWD)" | grep -q "^/workspace"; then \
		echo "Detected /workspace directory, syncing with $$HOME/devcontainer_clone..."; \
		mkdir -p "$$HOME/devcontainer_clone"; \
		unison "$(PWD)" "$$HOME/devcontainer_clone" \
			-ignore 'Path home' \
			-auto -batch -prefer "$(PWD)"; \
		echo "Switching to $$HOME/devcontainer_clone"; \
		cd "$$HOME/devcontainer_clone" && exec bash; \
	else \
		echo "Not under /workspace directory, no action taken."; \
		echo "Current directory: $(PWD)"; \
	fi

# Smart side-step: use unison if available, otherwise rsync
side-step:
	@if command -v unison >/dev/null 2>&1; then \
		echo "Using unison for bidirectional sync..."; \
		$(MAKE) sync; \
	else \
		echo "Unison not found, falling back to rsync..."; \
		$(MAKE) rsync; \
	fi

info:
	@echo Reponame discovered as $(REPONAME)
	@echo Workdir should be $(WORKDIR)
	@echo   REALHOSTNAME=$(REALHOSTNAME)
	@echo   CONTAINER_HOSTNAME=$(CONTAINER_HOSTNAME)


.PHONY: claude-beads claude-github setup-claude happy run build root pull-main \
   inside-setup outside-setup install-pat install-ssh-deploy-key gh-auth
