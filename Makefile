.PHONY: help setup rebase-upstream status feature-start feature-end

# Default target
help:
	@echo "Happy Repository Management"
	@echo ""
	@echo "Available targets:"
	@echo "  make setup           - Configure submodule remotes and branches"
	@echo "  make rebase-upstream - Fetch and rebase on upstream/main"
	@echo "  make status          - Show submodule branch status"
	@echo "  make feature-start   - Start a new feature branch (use FEATURE=name)"
	@echo "  make feature-end     - End feature branch and return to base development"
	@echo ""
	@echo "Examples:"
	@echo "  make setup"
	@echo "  make rebase-upstream"
	@echo "  make feature-start FEATURE=goremote-button"
	@echo "  make feature-end"
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
