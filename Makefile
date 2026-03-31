.PHONY: up down server web cli cli-stop logs clean

up: ## Start all containerized services (server + web)
	docker compose up -d --build

down: ## Stop all services
	docker compose down

server: ## Start only the backend server
	docker compose up -d --build server

web: ## Start only the web UI
	docker compose up -d --build web

seed: ## Authenticate CLI against local server (no mobile app needed)
	HAPPY_SERVER_URL=http://localhost:3005 node scripts/seed-cli-auth.mjs

machine-info: ## Report host machine info (ROOT=/path required)
	HAPPY_SERVER_URL=http://localhost:3005 HAPPY_WORKSPACE_ROOT=$(ROOT) node scripts/report-machine-info.mjs

cli: ## Start happy-cli daemon (ROOT=/path/to/workspace required)
	cd packages/happy-cli && HAPPY_SERVER_URL=http://localhost:3005 \
	  HAPPY_WORKSPACE_ROOT=$(ROOT) node bin/happy.mjs daemon start

cli-stop: ## Stop happy-cli daemon
	cd packages/happy-cli && node bin/happy.mjs daemon stop

cli-build: ## Build the happy CLI (required before daemon start)
	yarn workspace happy build

logs: ## Tail logs from all containers
	docker compose logs -f

logs-server: ## Tail server logs only
	docker compose logs -f server

logs-web: ## Tail web UI logs only
	docker compose logs -f web

clean: ## Stop containers and remove volumes
	docker compose down -v

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
