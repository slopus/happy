# Application session corrections

- Completed application sessions without a draft, and explicitly archived sessions, are collected into a collapsed history section per app. Running, permission-required, unfinished/disconnected, failed, and draft sessions remain visible. Expanding history preserves the same native session navigation. Continuing a completed session returns it to the main group when its state becomes running. This organizes history without terminating a processor or changing the lifecycle of another surface's execution.
- New AI-service bindings resolve null/default model and available reasoning defaults against the trusted target catalog. The resolved values are durable, preserving the approved identity, permissions and service tier. Previously created bindings remain unchanged; use a new conversation to adopt the resolved configuration.
- The companion Advisor fix is in its separate `fix/session-corrections` branch: persist request-keyed display transcripts across pre-session snapshots and conversation refresh, preventing a mode-prefixed input from duplicating the plain-text question.

Validation: application sidebar interaction component test; seven OTA runtime contract tests; app and server TypeScript checks; AI service store/authority/turn/transport/session-history suites and packaged SDK/HTTP smoke. PostgreSQL-only concurrency tests and a real-provider smoke case require external setup and were not run. Advisor: 187 passing tests, two existing live tests skipped, client build passed.

Independent review rejected an initial processor auto-close approach due to incoming-message races; that implementation was removed. No processor lifecycle or daemon behavior is changed in the final patch.

Screenshots were offered and are awaiting a user response. No browser E2E, new screenshots, or device video was recorded; component interaction and synthetic HTTP tests are not represented as visual or real-model acceptance. Production was not changed.
