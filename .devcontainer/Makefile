
SLOT=$(shell cat slot.txt)
USER=node

TAG := $(shell cat project_name.txt)

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
