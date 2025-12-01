---
title: Eliminate null-returning functions - adopt fail-fast error handling
status: open
priority: 2
issue_type: task
labels:
- code-quality
- error-handling
created_at: 2025-11-30T15:53:31.531652716+00:00
updated_at: 2025-11-30T15:53:31.531652716+00:00
---

# Description

The codebase has many functions that return null on failure instead of throwing errors. This leads to silent failures that are hard to debug.

## Problem
'Just returns null' is an anti-pattern. Functions either succeed or should generate clear errors.

## Scope
Identify and document all places where we have 'return null' behavior, especially:
- Encryption/decryption functions in webapp
- API response handlers
- State management functions

## Goal
Make the project null-safe with explicit error handling everywhere.

## Investigation Needed
- Determine if TypeScript strict null checks can help identify these patterns
- Create an audit of current null-returning functions
- Prioritize which functions to fix first based on impact
