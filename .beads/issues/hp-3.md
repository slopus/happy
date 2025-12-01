---
title: Add error banner system to webapp for user-visible errors
status: open
priority: 2
issue_type: task
labels:
- ux
- error-handling
- webapp
created_at: 2025-11-30T15:53:42.692022814+00:00
updated_at: 2025-11-30T15:53:42.692022814+00:00
---

# Description

We've had many silent failure conditions where the user has no idea something went wrong. We need a system to surface errors visibly in the UI.

## Problem
- Machine fetch failures are silent
- Auth validation failures don't show in UI
- Decryption failures are only logged to console
- Socket disconnections may not be obvious

## Requirements
- Global error banner component that can be triggered from anywhere
- Should support different severity levels (error, warning, info)
- Auto-dismiss for non-critical errors
- Manual dismiss for critical errors
- Works on both web and mobile

## Investigation
First check if such a system already exists (toast notifications, Modal system, etc) and extend it if so.

## Initial Use Case
Show banner when machines API fails to fetch or returns empty unexpectedly.
