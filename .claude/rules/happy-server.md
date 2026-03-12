---
paths:
  - packages/happy-server/**
---

## Gotchas

- Create Prisma migrations when schema changes — follow existing naming convention (`YYYYMMDDHHMMSS_description`). Run `yarn generate` when new types are needed
- Avoid enums — use maps instead

## Patterns to Follow

- Use `inTx` for database transactions, `afterTx` to emit events after commit succeeds
- Don't run non-transactional things (like file uploads) inside transactions
- Use `eventRouter.emitUpdate()` for persistent events, `emitEphemeral()` for transient
- Use `privacyKit.decodeBase64` / `privacyKit.encodeBase64` from `privacy-kit` — never use Buffer
- DB operation files: dedicated file in relevant `@/app/` subfolder, prefix with entity then action (e.g. `friendAdd`)
- After writing an action, add a documentation comment explaining the logic; keep it in sync
- All operations must be idempotent — clients may retry automatically
- Don't return values from action functions "just in case" — only essential returns
- Don't add logging unless asked
- Always use GitHub usernames
