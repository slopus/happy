.PHONY: help setup rebase-upstream status feature-start feature-end build build-cli build-server install demo demo-clean browser-inspect

# Default target
help:
	@echo "Happy Repository Management"
	@echo ""
	@echo "=== Build & Demo Targets ==="
	@echo "  make build           - Build all TypeScript code (CLI and server)"
	@echo "  make build-cli       - Build happy-cli only"
	@echo "  make build-server    - Typecheck happy-server only"
	@echo "  make install         - Install dependencies for all repos"
	@echo "  make demo            - Clean and launch full E2E demo"
	@echo "  make demo-clean      - Stop all services and clean logs"
	@echo "  make browser-inspect - Inspect webapp with headless browser (takes screenshot)"
	@echo ""
	@echo "=== Repository Management ==="
	@echo "  make setup           - Configure submodule remotes and branches"
	@echo "  make rebase-upstream - Fetch and rebase on upstream/main"
	@echo "  make status          - Show submodule branch status"
	@echo "  make feature-start   - Start a new feature branch (use FEATURE=name)"
	@echo "  make feature-end     - End feature branch and return to base development"
	@echo ""
	@echo "Examples:"
	@echo "  make build           # Rebuild all TypeScript after code changes"
	@echo "  make demo            # Clean start of full demo with web client"
	@echo "  make setup"
	@echo "  make feature-start FEATURE=goremote-button"
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
# Demo Targets
# ============================================================================

# Stop all services and clean logs
demo-clean:
	@echo "=== Stopping all services and cleaning logs ==="
	@./happy-demo.sh cleanup --clean-logs

# Full E2E demo: clean, build, and launch everything
demo: build demo-clean
	@echo ""
	@echo "=== Starting E2E Web Demo ==="
	@echo ""
	@./e2e-web-demo.sh

# Inspect webapp with headless browser (requires webapp to be running)
browser-inspect:
	@echo "=== Inspecting webapp with headless browser ==="
	@cd scripts/browser && node inspect-webapp.mjs --screenshot --console
