.PHONY: help setup rebase-upstream status feature-start feature-end build build-cli build-server install server stop logs cli e2e-test browser-inspect setup-credentials

# Default target
help:
	@echo "Happy Repository Management"
	@echo ""
	@echo "=== Server & Development ==="
	@echo "  make server          - Start all services (server + webapp)"
	@echo "  make stop            - Stop all services"
	@echo "  make logs            - View server logs"
	@echo "  make cli             - Run CLI with local server (uses ~/.happy)"
	@echo "  make setup-credentials - Auto-create test credentials in ~/.happy"
	@echo ""
	@echo "=== Build Targets ==="
	@echo "  make build           - Build all TypeScript code (CLI and server)"
	@echo "  make build-cli       - Build happy-cli only"
	@echo "  make build-server    - Typecheck happy-server only"
	@echo "  make install         - Install dependencies for all repos"
	@echo ""
	@echo "=== Testing ==="
	@echo "  make e2e-test        - Run full E2E test (isolated test credentials)"
	@echo "  make browser-inspect - Inspect webapp with headless browser"
	@echo ""
	@echo "=== Repository Management ==="
	@echo "  make setup           - Configure submodule remotes and branches"
	@echo "  make rebase-upstream - Fetch and rebase on upstream/main"
	@echo "  make status          - Show submodule branch status"
	@echo "  make feature-start   - Start a new feature branch (use FEATURE=name)"
	@echo "  make feature-end     - End feature branch and return to base development"
	@echo ""
	@echo "Examples:"
	@echo "  make server          # Start all services for development"
	@echo "  make cli             # Run CLI connected to local server"
	@echo "  make build           # Rebuild all TypeScript after code changes"
	@echo ""

# Setup submodule remotes and branches
setup:
	@./scripts/setup-submodules.sh

# Rebase all submodules on upstream/main
rebase-upstream: setup
	@./scripts/rebase-upstream.sh

# Show current status of all submodules
status:
	@echo ""
	@echo "=== Repository Status ==="
	@echo ""
	@echo "Parent branch: $$(git rev-parse --abbrev-ref HEAD)"
	@if [ -f feature_name.txt ]; then \
		echo "Feature mode: $$(cat feature_name.txt)"; \
	else \
		echo "Mode: Base development"; \
	fi
	@echo ""
	@echo "Submodule status:"
	@for submod in happy happy-cli happy-server; do \
		cd $$submod && \
		BRANCH=$$(git rev-parse --abbrev-ref HEAD) && \
		TRACKING=$$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo "none") && \
		AHEAD=$$(git rev-list --count @{u}..HEAD 2>/dev/null || echo "0") && \
		BEHIND=$$(git rev-list --count HEAD..@{u} 2>/dev/null || echo "0") && \
		echo "  $$submod: $$BRANCH (tracking $$TRACKING, +$$AHEAD -$$BEHIND)" && \
		cd ..; \
	done
	@echo ""

# Start a new feature branch
feature-start:
	@if [ -z "$(FEATURE)" ]; then \
		echo "Error: FEATURE name required. Usage: make feature-start FEATURE=name"; \
		exit 1; \
	fi
	@if [ -f feature_name.txt ]; then \
		echo "Error: Already in feature mode: $$(cat feature_name.txt)"; \
		echo "Run 'make feature-end' first"; \
		exit 1; \
	fi
	@echo "Starting feature: $(FEATURE)"
	@echo ""
	@# Create feature_name.txt
	@echo "$(FEATURE)" > feature_name.txt
	@# Create parent branch
	@echo "Creating parent branch: happy-$(FEATURE)"
	@git checkout -b happy-$(FEATURE) happy
	@# Add feature_name.txt to git
	@git add feature_name.txt
	@git commit -m "Start feature: $(FEATURE)"
	@echo ""
	@# Create feature branches in submodules
	@for submod in happy happy-cli happy-server; do \
		echo "Creating feature-$(FEATURE) in $$submod..."; \
		cd $$submod && \
		git checkout -b feature-$(FEATURE) main && \
		cd ..; \
	done
	@echo ""
	@echo "Feature $(FEATURE) started!"
	@echo "  Parent branch: happy-$(FEATURE)"
	@echo "  Submodule branches: feature-$(FEATURE)"
	@echo ""

# End feature branch and return to base development
feature-end:
	@if [ ! -f feature_name.txt ]; then \
		echo "Error: Not in feature mode"; \
		exit 1; \
	fi
	@FEATURE=$$(cat feature_name.txt) && \
	echo "Ending feature: $$FEATURE" && \
	echo "" && \
	echo "Checking out main in submodules..." && \
	for submod in happy happy-cli happy-server; do \
		cd $$submod && \
		git checkout main && \
		cd ..; \
	done && \
	echo "" && \
	echo "Switching to happy branch..." && \
	git checkout happy && \
	echo "" && \
	echo "Removing feature_name.txt..." && \
	rm -f feature_name.txt && \
	git add feature_name.txt && \
	git commit -m "End feature: $$FEATURE" && \
	echo "" && \
	echo "Feature $$FEATURE ended!" && \
	echo "  Feature branches still exist but are not active" && \
	echo "  Delete them manually if no longer needed:" && \
	echo "    git branch -D happy-$$FEATURE" && \
	echo "    cd <submodule> && git branch -D feature-$$FEATURE" && \
	echo ""

# ============================================================================
# Build Targets
# ============================================================================

# Install dependencies for all repositories
install:
	@echo "=== Installing dependencies for all repositories ==="
	@echo ""
	@echo "Installing happy-server dependencies..."
	@cd happy-server && yarn install
	@echo ""
	@echo "Installing happy-cli dependencies..."
	@cd happy-cli && yarn install
	@echo ""
	@echo "Installing happy webapp dependencies..."
	@cd happy && yarn install
	@echo ""
	@echo "=== All dependencies installed ==="

# Build happy-cli (compiles TypeScript to dist/)
build-cli:
	@echo "=== Building happy-cli ==="
	@cd happy-cli && yarn build
	@echo "=== happy-cli build complete ==="

# Typecheck happy-server (runs with tsx, no compilation needed)
build-server:
	@echo "=== Typechecking happy-server ==="
	@cd happy-server && yarn build
	@echo "=== happy-server typecheck complete ==="

# Build all TypeScript code
# Note: happy webapp uses Expo and builds at runtime, no pre-build needed
build: build-cli build-server
	@echo ""
	@echo "=== All builds complete ==="
	@echo ""
	@echo "Built components:"
	@echo "  - happy-cli:    dist/ directory updated"
	@echo "  - happy-server: TypeScript validated (runs directly with tsx)"
	@echo "  - happy webapp: No pre-build needed (Expo builds at runtime)"
	@echo ""

# ============================================================================
# Server & Development Targets
# ============================================================================

# Start all services (server + webapp) - no test credentials created
server: build
	@echo ""
	@echo "=== Starting Happy Server ==="
	@echo ""
	@./start-server.sh

# Stop all services
stop:
	@echo "=== Stopping all services ==="
	@./happy-demo.sh cleanup
	@pkill -f 'expo start' 2>/dev/null || true
	@echo "All services stopped"

# View server logs
logs:
	@./happy-demo.sh logs server

# Run CLI with local server (uses default ~/.happy credentials)
cli:
	HAPPY_SERVER_URL=http://localhost:3005 ./happy-cli/bin/happy.mjs

list:
	HAPPY_SERVER_URL=http://localhost:3005 ./happy-cli/bin/happy.mjs list

# Auto-create credentials in ~/.happy (for quick setup)
setup-credentials:
	@echo "=== Creating credentials in ~/.happy ==="
	@HAPPY_HOME_DIR=~/.happy HAPPY_SERVER_URL=http://localhost:3005 node scripts/setup-test-credentials.mjs

# ============================================================================
# Testing Targets
# ============================================================================

# Full E2E test with isolated test credentials (for CI/testing only)
e2e-test: build
	@echo ""
	@echo "=== Running E2E Test (isolated credentials) ==="
	@echo ""
	@./happy-demo.sh cleanup --clean-logs
	@./e2e-web-demo.sh

# Inspect webapp with headless browser (requires webapp to be running)
browser-inspect:
	@echo "=== Inspecting webapp with headless browser ==="
	@cd scripts/browser && node inspect-webapp.mjs --screenshot --console
