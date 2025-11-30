# E2E Testing Architecture Plan

## Implementation Status

**Phase 1: COMPLETED** ✅

The E2E testing infrastructure is now in place. Key components:

- `scripts/e2e/` - New vitest-based E2E test directory
- Atomic slot allocation system for parallel test execution
- Helper modules for browser, CLI, and server operations
- TypeScript port of create-account test
- Updated validate.sh with `--vitest` flag

## Current State

### What We Have Now

#### Legacy System (still works)
- `scripts/validate.sh` - Bash orchestration script (default mode)
- `scripts/browser/` - Playwright-based browser tests (JavaScript)

#### New System (use `--vitest` flag)
- `scripts/e2e/` - TypeScript/Vitest-based E2E tests
  - `helpers/slots.ts` - Atomic slot allocation (supports 10 parallel slots)
  - `helpers/server.ts` - Service start/stop using happy-launcher.sh
  - `helpers/browser.ts` - Playwright utilities
  - `helpers/cli.ts` - CLI command helpers
  - `tests/webapp/create-account.test.ts` - Account creation test
  - `vitest.config.ts` - Test configuration

### Usage

```bash
# Legacy mode (default)
./scripts/validate.sh

# New vitest mode with automatic slot allocation
./scripts/validate.sh --vitest

# Quick mode (skip E2E tests)
./scripts/validate.sh --quick

# E2E only (skip builds and unit tests)
./scripts/validate.sh --e2e-only --vitest
```

---

## Slot Allocation System

### How It Works

Each test file claims a slot atomically:
1. Look for `slot-N-available` file in `/tmp/happy-slots/`
2. Atomically rename to `slot-N-claimed-{pid}`
3. Get isolated ports and directories for that slot
4. On test completion, release slot back to available

### Port Allocation

| Slot | Server | Webapp | MinIO | MinIO Console | Metrics |
|------|--------|--------|-------|---------------|---------|
| 0 (prod) | 3005 | 8081 | 9000 | 9001 | 9090 |
| 1 | 10001 | 10002 | 10003 | 10004 | 10005 |
| 2 | 10011 | 10012 | 10013 | 10014 | 10015 |
| 3 | 10021 | 10022 | 10023 | 10024 | 10025 |
| ... | +10 | +10 | +10 | +10 | +10 |

### Benefits

1. **True Parallelism**: Up to 10 test files can run simultaneously
2. **No Port Conflicts**: Each slot has dedicated ports
3. **Clean Isolation**: Each slot has its own:
   - Home directory (`/tmp/.happy-e2e-slot-N`)
   - Log directory (`/tmp/happy-slot-N`)
   - MinIO data directory
4. **Crash Recovery**: Stale slots from crashed processes are auto-cleaned

---

## Remaining Work

### Phase 2: Expand Tests (Next Steps)

1. **Port remaining browser tests**
   - `test-webapp-e2e.mjs` → `tests/webapp/restore-login.test.ts`
   - `test-restore-login.mjs` → merge into above

2. **Add CLI tests**
   - `tests/cli/daemon.test.ts` - Daemon start/stop/status
   - `tests/cli/auth.test.ts` - Authentication flow

3. **Implement integration tests**
   - `tests/integration/local-remote-switch.test.ts`
   - `tests/integration/message-sync.test.ts`

### Phase 3: CI Integration

1. Switch CI to use `--vitest` flag by default
2. Add parallel matrix builds
3. Configure failure screenshots/artifacts

---

## Architecture

### Directory Structure (Implemented)

```
scripts/
├── validate.sh              # Entry point with --vitest flag
├── browser/                 # Legacy tests (JavaScript)
│   ├── test-create-account.mjs
│   ├── test-webapp-e2e.mjs
│   └── test-restore-login.mjs
└── e2e/                     # NEW: Vitest tests (TypeScript)
    ├── package.json
    ├── tsconfig.json
    ├── vitest.config.ts
    ├── setup.ts             # Global setup/teardown
    ├── helpers/
    │   ├── index.ts         # Re-exports
    │   ├── slots.ts         # Atomic slot allocation
    │   ├── server.ts        # Service management
    │   ├── browser.ts       # Playwright utilities
    │   └── cli.ts           # CLI helpers
    └── tests/
        ├── webapp/
        │   └── create-account.test.ts
        ├── cli/             # TODO
        └── integration/     # TODO
```

### Test Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                         validate.sh --vitest                          │
├──────────────────────────────────────────────────────────────────────┤
│  1. Build checks (sequential)                                         │
│     - happy-cli build                                                 │
│     - happy-server typecheck                                          │
│     - happy webapp typecheck                                          │
│                                                                       │
│  2. Unit tests (parallel via vitest)                                  │
│     - happy-server unit tests                                         │
│     - happy-cli unit tests                                            │
│                                                                       │
│  3. E2E tests (vitest with slot allocation)                           │
│     ┌─────────────────────────────────────────────────────────────┐  │
│     │  Each test file:                                             │  │
│     │    1. Claims a slot atomically                               │  │
│     │    2. Starts services on that slot                           │  │
│     │    3. Runs browser/CLI tests                                 │  │
│     │    4. Stops services                                         │  │
│     │    5. Releases slot                                          │  │
│     │                                                              │  │
│     │  Multiple test files run in parallel, each on its own slot   │  │
│     └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### Parallelism Strategy

```
Test Files (can run in parallel, each claims own slot):
├── webapp/create-account.test.ts  → Slot 1
├── webapp/restore-login.test.ts   → Slot 2
├── cli/daemon.test.ts             → Slot 3
└── integration/local-remote.test.ts → Slot 4

Within each test file:
└── Tests run sequentially (share server state)
```

---

## Answered Questions

1. **Slot usage**: ✅ Each test file claims its own slot atomically (up to 10 parallel)
2. **Test data isolation**: ✅ Each slot has isolated home directory
3. **Timeout handling**: ✅ Configured in vitest.config.ts (2min test, 3min hook)
4. **Screenshot storage**: ✅ Saved to `/tmp/happy-slot-N/screenshots/`

---

## Example: Creating a New Test

```typescript
// scripts/e2e/tests/integration/my-test.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    startServices,
    ServerHandle,
    launchBrowser,
    BrowserHandle,
} from '../../helpers/index.js';

describe('My Integration Test', () => {
    let server: ServerHandle;
    let browser: BrowserHandle;

    beforeAll(async () => {
        // Automatically claims an available slot
        server = await startServices();
        browser = await launchBrowser(server.slot.config);
    }, 180000);

    afterAll(async () => {
        await browser?.close();
        // Automatically releases slot
        await server?.stop();
    });

    it('should do something', async () => {
        const { page } = browser;
        await page.goto('/');
        // ... test logic
    });
});
```
