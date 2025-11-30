---
title: E2E Testing Infrastructure Epic
status: open
priority: 0
issue_type: epic
created_at: 2025-11-30T12:07:56.914019246+00:00
updated_at: 2025-11-30T12:07:56.914019246+00:00
---

# Description

Track the implementation of E2E testing infrastructure for the Happy project.

## Completed Work
- [x] Set up vitest-based E2E test framework (scripts/e2e/)
- [x] Implement slot-based port isolation for parallel test execution
- [x] Create browser automation helpers using Playwright
- [x] Add server startup/shutdown helpers (happy-launcher.sh integration)
- [x] Fix webapp port configuration (URL hash parameter for runtime port override)
- [x] Fix NODE_ENV=test causing expo-router build failure in CI
- [x] Set up GitHub Actions CI workflow
- [x] All E2E tests passing on CI

## Current Test Coverage
- Webapp create account flow (tests/webapp/create-account.test.ts)

## Future Work
- [ ] Add more webapp tests (login, restore account, navigation)
- [ ] Add CLI tests (happy-cli commands)
- [ ] Add integration tests (webapp + CLI interactions)
- [ ] Consider visual regression testing
- [ ] Add test coverage reporting

## Architecture
- Vitest for test runner with parallel execution support
- Playwright for browser automation
- Slot-based isolation: each test gets isolated ports (slot N uses ports 10001+N*10)
- happy-launcher.sh manages all service lifecycle
- URL hash parameter (#server=PORT) for runtime server port configuration

## Key Files
- scripts/e2e/ - E2E test framework
- scripts/e2e/helpers/ - Test utilities (browser, server, slots)
- scripts/e2e/tests/ - Test files organized by component
- scripts/validate.sh - Pre-commit validation script
- .github/workflows/ci.yml - CI configuration
- happy-launcher.sh - Service management script
