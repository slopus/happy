# Repository Conventions (Happy monorepo)

This file provides cross-cutting guidance for Claude Code (claude.ai/code) when working in this monorepo.

Package-specific guidance lives in:
- `cli/CLAUDE.md` (Happy CLI)
- `expo-app/CLAUDE.md` (Expo app)
- `server/CLAUDE.md` (Server)

## Naming conventions (shared)

These are repo-wide defaults. **If a package-specific `CLAUDE.md` conflicts with this file, the package-specific file wins** (e.g. the server has its own directory naming conventions).

### Folders
- Buckets: lowercase (e.g. `components`, `hooks`, `utils`, `modules`, `types`)
- Feature folders: `camelCase` (e.g. `newSession`, `agentInput`)
- Avoid `_folders` except special/framework files and `__tests__`

### Files
- React components: `PascalCase.tsx`
- Hooks: `useThing.ts`
- Plain TS modules: `camelCase.ts`

### Allowed `_*.ts` markers (organization only)

Allowed only inside “module-ish” directories (e.g. `modules/`, `ops/`, `phases/`, `helpers/`, `domains/`):
- `_types.ts`
- `_shared.ts`
- `_constants.ts`

No other `_*.ts` file names should be introduced.
