
SLOT=$(shell cat slot.txt)
USER=ubuntu

TAG := $(shell cat project_name.txt)

ifeq ($(strip $(TAG)),)
    $(error TAG must be set (from project_name.txt) and not empty!)
endif

OS := $(shell uname)

ifeq ($(OS),Darwin)
    CONTAINER=docker
else ifeq ($(OS),Linux)
    CONTAINER=podman
else
    CONTAINER= echo Unsupported_OS && exit 1
endif

build: Dockerfile
	$(CONTAINER) build -t $(TAG)-$(SLOT) .

run:
	$(CONTAINER) run -it --rm -u $(USER) \
		-v `pwd`/home:/home/$(USER) \
		-v `pwd`/..:/workspace \
		$(TAG)-$(SLOT) bash

root:
	$(CONTAINER) run -it --rm -u root \
		-v `pwd`/home:/root \
		-v `pwd`/..:/workspace \
		$(TAG)-$(SLOT) bash

Dockerfile: Dockerfile.prefix Dockerfile.project
	cat Dockerfile.prefix Dockerfile.project > Dockerfile

# TODO: need a way to pass this into happy on the CLI.
# It can take an MCP action to change it, but that's lame and wasteful.
.session_title.txt:
	echo $(TAG)-`hostname` > $@

happy: .session_title.txt
	TITLE=`cat $^` && cd .. && \
	happy claude --dangerously-skip-permissions "Tell happy to change the title to $$TITLE"

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
	claude mcp add --transport http github https://api.githubcopilot.com/mcp -H "Authorization: Bearer $GITHUB_PERSONAL_ACCESS_TOKEN"

# From inside the container:
claude-beads:
	claude plugin marketplace add steveyegge/beads
	claude plugin install beads

outside-setup: install-pat

inside-setup: claude-github claude-beads install-ssh-deploy-key

# Pull and rebase any upstream changes to the central config on the main branch.
pull-main:
	git diff --exit-code || \
	(echo "Please commit or stash your changes before pulling." && exit 1) && \
	BRANCH=`git branch --show-current` && \
	git checkout main && \
	git pull origin main && \
	git checkout $$BRANCH && \
	git merge main

.PHONY: claude-beads claude-github setup-claude happy run build root pull-main \
   inside-setup outside-setup install-pat install-ssh-deploy-key
