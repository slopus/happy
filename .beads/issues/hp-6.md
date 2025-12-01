---
title: Dynamic server URL not working
status: open
priority: 2
issue_type: task
created_at: 2025-12-01T19:35:00.625713016+00:00
updated_at: 2025-12-01T19:35:00.625713016+00:00
---

# Description

The daemon won't start and 'auth status' says server may be unreachable. 'auth login --backup-key' similarly cannot connect. First, update 'auth status' and 'auth login' to actually say WHAT server it is attempting to connect to. That will make the problem much more obvious.
