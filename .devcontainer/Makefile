
SLOT=$(shell cat slot.txt)
USER=node

TAG=mtg-forge

# CONTAINER=docker
CONTAINER=podman

build:
	$(CONTAINER) build -t $(TAG)-$(SLOT) .

run:
	$(CONTAINER) run -it --rm -u $(USER) \
		-v `pwd`/home:/home/node \
		-v `pwd`/..:/workspace \
		$(TAG)-$(SLOT) bash

root:
	$(CONTAINER) run -it --rm -u root \
		-v `pwd`/home:/root \
		-v `pwd`/..:/workspace \
		$(TAG)-$(SLOT) bash

run_old:
	$(CONTAINER) run -it --rm \
		-v `pwd`/claude-persist/.claude:/home/node/.claude \
		-v `pwd`/claude-persist/.claude.json:/home/node/.claude.json \
		$(TAG)-$(SLOT) bash
