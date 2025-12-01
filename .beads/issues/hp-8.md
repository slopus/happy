---
title: E2E Testing Epic - Expand Coverage
status: open
priority: 1
issue_type: epic
created_at: 2025-12-01T19:35:03.411878007+00:00
updated_at: 2025-12-01T19:35:03.411878007+00:00
---

# Description

Greatly flesh out e2e testing. Goals:
- Browser based e2e tests with reasonable coverage of app flows (subscreens, buttons)
- Tests run in parallel where appropriate, sharing server setup/teardown as needed
- Keep full validate under 5 min locally and under 10 min on GitHub CI/CD

Subtasks to track:
- [ ] Fix e2e tests for new error banners (disabled due to flakiness, investigate until stable)
