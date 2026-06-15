# Interactive Claude Remote Release Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close interactive Claude remote release blockers 1-4: tmux auth/env, explicit tmux selection, safe input readiness, and privacy-safe attachment upload logs.

**Architecture:** Keep the existing interactive remote runtime. Add narrow helpers at the boundaries that caused the release blockers: tmux backend selection/env filtering, terminal input readiness classification, readiness wait result handling, and attachment upload log formatting. Each helper is covered by focused unit tests before being wired into the launcher or app sync path.

**Tech Stack:** TypeScript, Vitest, Happy CLI terminal transports, Happy app sync/attachment upload code.

---

## File Structure

- Modify `packages/happy-cli/src/claude/interactive/terminalTransport.ts`
  - Keep backend selection logic small and testable.
- Modify `packages/happy-cli/src/claude/interactive/terminalTransportFactory.ts`
  - Normalize `TMUX_SESSION_NAME` to a non-empty explicit session name before choosing tmux.
- Modify `packages/happy-cli/src/claude/interactive/tmuxTerminalTransport.ts`
  - Expand tmux env filtering to allow only Claude/Anthropic/MCP/proxy/runtime env needed by the managed Claude process.
- Modify `packages/happy-cli/src/claude/interactive/terminalTransport.test.ts`
  - Update backend selection expectations and tmux env allowlist coverage.
- Create `packages/happy-cli/src/claude/interactive/terminalTransportFactory.test.ts`
  - Prove empty and absent `TMUX_SESSION_NAME` use PTY even when tmux exists.
- Create `packages/happy-cli/src/claude/interactive/inputReadiness.ts`
  - Classify only the latest terminal tail for prompt readiness.
- Create `packages/happy-cli/src/claude/interactive/inputReadiness.test.ts`
  - Cover ready tail prompt forms and stale/quoted/diff/spinner false positives.
- Modify `packages/happy-cli/src/claude/claudeInteractiveRemoteLauncher.ts`
  - Use the readiness helper for input-ready and turn-complete signals.
  - Replace blind timeout with explicit `ready | timeout | cancelled | exited` results.
- Modify `packages/happy-cli/src/claude/claudeInteractiveRemoteLauncher.test.ts`
  - Prove no paste on timeout, no paste on stale prompts, abort/exit wakeups are not timeout failures, and later real prompts recover.
- Create `packages/happy-app/sources/sync/attachmentUploadLogging.ts`
  - Format safe attachment upload log metadata.
- Create `packages/happy-app/sources/sync/attachmentUploadLogging.test.ts`
  - Prove raw identifiers, paths, refs, and raw error messages/stacks are excluded.
- Modify `packages/happy-app/sources/sync/sync.ts`
  - Replace raw attachment upload `console.error` calls with the safe helper.

---

### Task 1: Harden tmux Backend Selection And Env Filtering

**Files:**
- Modify: `packages/happy-cli/src/claude/interactive/terminalTransport.ts`
- Modify: `packages/happy-cli/src/claude/interactive/terminalTransportFactory.ts`
- Modify: `packages/happy-cli/src/claude/interactive/tmuxTerminalTransport.ts`
- Modify: `packages/happy-cli/src/claude/interactive/terminalTransport.test.ts`
- Create: `packages/happy-cli/src/claude/interactive/terminalTransportFactory.test.ts`

- [ ] **Step 1: Update the backend selection tests**

In `packages/happy-cli/src/claude/interactive/terminalTransport.test.ts`, replace the current test named `uses tmux when it is available even without an explicit session name` with:

```ts
it('falls back to pty when tmux is available but no session is configured', () => {
    expect(chooseTerminalBackend({
        tmuxConfigured: false,
        tmuxAvailable: true,
        ptyAvailable: true,
    })).toBe('pty');
});
```

In the same file, replace the `filters sensitive and path-like environment before spawning in tmux` test body with:

```ts
it('passes only Claude runtime env through tmux filtering', async () => {
    const tmux = {
        spawnInTmux: vi.fn(async () => ({ success: true, sessionId: 'happy:claude', pid: 457 })),
        isPaneAlive: vi.fn(async () => true),
        capturePaneText: vi.fn(async () => ''),
        killWindow: vi.fn(async () => true),
    };
    const transport = new TmuxTerminalTransport('happy-test', tmux as any);

    await transport.spawn({
        ...requiredSpawnOptions,
        env: {
            ALL_PROXY: 'socks://proxy.example',
            ANTHROPIC_API_KEY: 'anthropic-key',
            ANTHROPIC_BASE_URL: 'https://anthropic.example',
            API_TIMEOUT_MS: '60000',
            AUTHORIZATION: 'Bearer secret',
            CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
            CLAUDE_CONFIG_DIR: '/tmp/claude',
            COLORTERM: 'truecolor',
            COOKIE: 'session=secret',
            CUSTOM_KEY: 'custom-key',
            CUSTOM_SECRET: 'custom-secret',
            GITHUB_TOKEN: 'github-token',
            HAPPY_CLAUDE_PATH: '/opt/claude/bin/claude',
            HAPPY_FORKED_FROM_SESSION_ID: 'fork-session',
            HAPPY_RECONNECT_ENCRYPTION_KEY: 'reconnect-key',
            HAPPY_SERVER_URL: 'https://happy.example',
            HOME: '/Users/devdvlive',
            HTTP_PROXY: 'http://proxy.example',
            HTTPS_PROXY: 'https://secure-proxy.example',
            LANG: 'en_US.UTF-8',
            LC_ALL: 'en_US.UTF-8',
            LOGNAME: 'devdvlive',
            MCP_CONNECTION_NONBLOCKING: '1',
            NO_PROXY: 'localhost,127.0.0.1',
            NODE_EXTRA_CA_CERTS: '/tmp/certs.pem',
            PASSWORD: 'password',
            PATH: '/opt/bin:/usr/bin',
            SHELL: '/bin/zsh',
            SSH_AUTH_SOCK: '/tmp/ssh.sock',
            SSL_CERT_DIR: '/tmp/certs',
            SSL_CERT_FILE: '/tmp/cert.pem',
            TERM: 'xterm-256color',
            TMPDIR: '/tmp',
            USER: 'devdvlive',
            all_proxy: 'socks://lower-proxy.example',
            http_proxy: 'http://lower-proxy.example',
            https_proxy: 'https://lower-secure-proxy.example',
            no_proxy: 'localhost',
        },
    });

    expect(tmux.spawnInTmux).toHaveBeenCalledWith(
        ['claude'],
        expect.objectContaining({
            cwd: '/tmp',
            sessionName: 'happy-test',
            windowName: 'claude',
        }),
        {
            ALL_PROXY: 'socks://proxy.example',
            ANTHROPIC_API_KEY: 'anthropic-key',
            ANTHROPIC_BASE_URL: 'https://anthropic.example',
            API_TIMEOUT_MS: '60000',
            CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
            CLAUDE_CONFIG_DIR: '/tmp/claude',
            COLORTERM: 'truecolor',
            HAPPY_CLAUDE_PATH: '/opt/claude/bin/claude',
            HOME: '/Users/devdvlive',
            HTTP_PROXY: 'http://proxy.example',
            HTTPS_PROXY: 'https://secure-proxy.example',
            LANG: 'en_US.UTF-8',
            LC_ALL: 'en_US.UTF-8',
            LOGNAME: 'devdvlive',
            MCP_CONNECTION_NONBLOCKING: '1',
            NO_PROXY: 'localhost,127.0.0.1',
            NODE_EXTRA_CA_CERTS: '/tmp/certs.pem',
            PATH: '/opt/bin:/usr/bin',
            SHELL: '/bin/zsh',
            SSH_AUTH_SOCK: '/tmp/ssh.sock',
            SSL_CERT_DIR: '/tmp/certs',
            SSL_CERT_FILE: '/tmp/cert.pem',
            TERM: 'xterm-256color',
            TMPDIR: '/tmp',
            USER: 'devdvlive',
            all_proxy: 'socks://lower-proxy.example',
            http_proxy: 'http://lower-proxy.example',
            https_proxy: 'https://lower-secure-proxy.example',
            no_proxy: 'localhost',
        },
    );
    await transport.dispose();
});
```

- [ ] **Step 2: Add terminal transport factory tests**

Create `packages/happy-cli/src/claude/interactive/terminalTransportFactory.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockIsTmuxAvailable = vi.hoisted(() => vi.fn());

vi.mock('@/utils/tmux', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/tmux')>();
    return {
        ...actual,
        isTmuxAvailable: mockIsTmuxAvailable,
    };
});

import { createTerminalTransport } from './terminalTransportFactory';

describe('createTerminalTransport', () => {
    beforeEach(() => {
        mockIsTmuxAvailable.mockReset();
        mockIsTmuxAvailable.mockResolvedValue(true);
    });

    it('uses tmux only when TMUX_SESSION_NAME is non-empty', async () => {
        const transport = await createTerminalTransport({ TMUX_SESSION_NAME: 'happy' });

        expect(transport?.backend).toBe('tmux');
    });

    it('uses pty when TMUX_SESSION_NAME is absent even if tmux is available', async () => {
        const transport = await createTerminalTransport({});

        expect(transport?.backend).toBe(process.platform === 'win32' ? undefined : 'pty');
    });

    it('uses pty when TMUX_SESSION_NAME is empty even if tmux is available', async () => {
        const transport = await createTerminalTransport({ TMUX_SESSION_NAME: '' });

        expect(transport?.backend).toBe(process.platform === 'win32' ? undefined : 'pty');
    });

    it('uses pty when TMUX_SESSION_NAME is whitespace even if tmux is available', async () => {
        const transport = await createTerminalTransport({ TMUX_SESSION_NAME: '   ' });

        expect(transport?.backend).toBe(process.platform === 'win32' ? undefined : 'pty');
    });
});
```

- [ ] **Step 3: Run the focused CLI transport tests and verify they fail**

Run:

```bash
pnpm --filter happy exec vitest run --project unit src/claude/interactive/terminalTransport.test.ts src/claude/interactive/terminalTransportFactory.test.ts
```

Expected: FAIL. The old backend selector still chooses `tmux` when `tmuxConfigured` is false, and the tmux env filter still drops Claude auth/env.

- [ ] **Step 4: Implement non-empty tmux configuration and env allowlist**

In `packages/happy-cli/src/claude/interactive/terminalTransport.ts`, replace `chooseTerminalBackend()` with:

```ts
export function chooseTerminalBackend(availability: TerminalBackendAvailability): TerminalBackendSelection {
    if (availability.tmuxConfigured && availability.tmuxAvailable) {
        return 'tmux';
    }

    if (availability.ptyAvailable) {
        return 'pty';
    }

    return 'unsupported';
}
```

In `packages/happy-cli/src/claude/interactive/terminalTransportFactory.ts`, replace the function body with:

```ts
export async function createTerminalTransport(env: NodeJS.ProcessEnv = process.env): Promise<TerminalTransport | null> {
    const tmuxSessionName = typeof env.TMUX_SESSION_NAME === 'string' && env.TMUX_SESSION_NAME.trim().length > 0
        ? env.TMUX_SESSION_NAME
        : null;
    const backend = chooseTerminalBackend({
        tmuxConfigured: tmuxSessionName !== null,
        tmuxAvailable: await isTmuxAvailable(),
        ptyAvailable: process.platform !== 'win32',
    });

    switch (backend) {
        case 'tmux':
            return new TmuxTerminalTransport(tmuxSessionName!);
        case 'pty':
            return new PtyTerminalTransport();
        case 'unsupported':
            return null;
        default: {
            const _: never = backend satisfies never;
            return _;
        }
    }
}
```

In `packages/happy-cli/src/claude/interactive/tmuxTerminalTransport.ts`, replace the current `TMUX_ENV_ALLOWLIST` and `filterTmuxEnvironment()` block with:

```ts
const TMUX_ENV_EXACT_ALLOWLIST = new Set([
    'ALL_PROXY',
    'API_TIMEOUT_MS',
    'COLORTERM',
    'HAPPY_CLAUDE_PATH',
    'HOME',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'LANG',
    'LOGNAME',
    'NO_PROXY',
    'NODE_EXTRA_CA_CERTS',
    'PATH',
    'SHELL',
    'SSH_AUTH_SOCK',
    'SSL_CERT_DIR',
    'SSL_CERT_FILE',
    'TERM',
    'TMPDIR',
    'USER',
    'all_proxy',
    'http_proxy',
    'https_proxy',
    'no_proxy',
]);

const TMUX_ENV_PREFIX_ALLOWLIST = [
    'ANTHROPIC_',
    'CLAUDE_',
    'LC_',
    'MCP_',
] as const;

function filterTmuxEnvironment(env: Record<string, string>): Record<string, string> {
    const filtered: Record<string, string> = {};

    for (const [key, value] of Object.entries(env)) {
        if (isAllowedTmuxEnvironmentKey(key)) {
            filtered[key] = value;
        }
    }

    return filtered;
}

function isAllowedTmuxEnvironmentKey(key: string): boolean {
    if (TMUX_ENV_EXACT_ALLOWLIST.has(key)) {
        return true;
    }

    return TMUX_ENV_PREFIX_ALLOWLIST.some((prefix) => key.startsWith(prefix));
}
```

- [ ] **Step 5: Run the focused CLI transport tests and verify they pass**

Run:

```bash
pnpm --filter happy exec vitest run --project unit src/claude/interactive/terminalTransport.test.ts src/claude/interactive/terminalTransportFactory.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add packages/happy-cli/src/claude/interactive/terminalTransport.ts \
  packages/happy-cli/src/claude/interactive/terminalTransportFactory.ts \
  packages/happy-cli/src/claude/interactive/tmuxTerminalTransport.ts \
  packages/happy-cli/src/claude/interactive/terminalTransport.test.ts \
  packages/happy-cli/src/claude/interactive/terminalTransportFactory.test.ts
git commit -m "fix: require explicit tmux session for claude remote"
```

---

### Task 2: Add Terminal Input Readiness Helper

**Files:**
- Create: `packages/happy-cli/src/claude/interactive/inputReadiness.ts`
- Create: `packages/happy-cli/src/claude/interactive/inputReadiness.test.ts`

- [ ] **Step 1: Write the failing readiness helper tests**

Create `packages/happy-cli/src/claude/interactive/inputReadiness.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isTerminalInputReady } from './inputReadiness';

describe('isTerminalInputReady', () => {
    it('accepts a bare prompt at the terminal tail', () => {
        expect(isTerminalInputReady('>')).toBe(true);
        expect(isTerminalInputReady('Claude Code v2.1.153\n>')).toBe(true);
    });

    it('accepts the styled Claude prompt at the terminal tail', () => {
        expect(isTerminalInputReady('Claude Code v2.1.153\n❯')).toBe(true);
        expect(isTerminalInputReady('Claude Code v2.1.153\n❯ Try "fix lint errors"')).toBe(true);
    });

    it('ignores stale prompt lines followed by later output', () => {
        expect(isTerminalInputReady('>\nWorking on it...')).toBe(false);
        expect(isTerminalInputReady('❯ Try "fix lint errors"\nThinking...')).toBe(false);
    });

    it('does not treat markdown quote lines as readiness', () => {
        expect(isTerminalInputReady('> quoted text')).toBe(false);
        expect(isTerminalInputReady('assistant output\n> quoted text')).toBe(false);
    });

    it('does not treat rendered diff or test fixtures as readiness', () => {
        const output = [
            'diff --git a/packages/happy-cli/src/claude/interactive/terminalObserver.test.ts b/packages/happy-cli/src/claude/interactive/terminalObserver.test.ts',
            '--- a/packages/happy-cli/src/claude/interactive/terminalObserver.test.ts',
            '+++ b/packages/happy-cli/src/claude/interactive/terminalObserver.test.ts',
            "+        expect(classifyTerminalOutput('>')).toEqual({",
            "+            type: 'input_prompt_visible',",
            '+        });',
        ].join('\n');

        expect(isTerminalInputReady(output)).toBe(false);
    });

    it('rejects prompt-looking output while progress is still visible at the tail', () => {
        expect(isTerminalInputReady('12 tokens remaining\n❯ Try "keep going"')).toBe(false);
        expect(isTerminalInputReady('thinking...\n>')).toBe(false);
    });

    it('strips ANSI escapes before checking the terminal tail', () => {
        expect(isTerminalInputReady('\x1b[32m❯\x1b[0m')).toBe(true);
    });
});
```

- [ ] **Step 2: Run the readiness helper test and verify it fails**

Run:

```bash
pnpm --filter happy exec vitest run --project unit src/claude/interactive/inputReadiness.test.ts
```

Expected: FAIL because `./inputReadiness` does not exist.

- [ ] **Step 3: Implement the readiness helper**

Create `packages/happy-cli/src/claude/interactive/inputReadiness.ts`:

```ts
const ANSI_ESCAPE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const TAIL_PROGRESS_PATTERN = /\b(?:spinner without transcript|no transcript|waiting for transcript|press esc to interrupt|esc to interrupt|ctrl\+c to cancel|tokens? remaining)\b|(?:^|\s)thinking\.{3}(?:\s|$)/i;
const STYLED_PROMPT_PATTERN = /^❯(?:\s+Try\s+"[^"]*")?$/;

export function isTerminalInputReady(raw: string): boolean {
    const meaningfulLines = raw
        .replace(/\r/g, '\n')
        .split('\n')
        .map((line) => stripAnsi(line).trim())
        .filter(Boolean);

    if (meaningfulLines.length === 0) {
        return false;
    }

    const tailLines = meaningfulLines.slice(-3);
    const tailText = tailLines.join('\n');
    if (TAIL_PROGRESS_PATTERN.test(tailText)) {
        return false;
    }

    const lastLine = meaningfulLines[meaningfulLines.length - 1];
    return lastLine === '>' || STYLED_PROMPT_PATTERN.test(lastLine);
}

function stripAnsi(value: string): string {
    return value.replace(ANSI_ESCAPE_PATTERN, '');
}
```

- [ ] **Step 4: Run the readiness helper test and verify it passes**

Run:

```bash
pnpm --filter happy exec vitest run --project unit src/claude/interactive/inputReadiness.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git add packages/happy-cli/src/claude/interactive/inputReadiness.ts \
  packages/happy-cli/src/claude/interactive/inputReadiness.test.ts
git commit -m "fix: classify claude terminal input readiness"
```

---

### Task 3: Wire Readiness Helper And Remove Blind Paste Timeout

**Files:**
- Modify: `packages/happy-cli/src/claude/claudeInteractiveRemoteLauncher.ts`
- Modify: `packages/happy-cli/src/claude/claudeInteractiveRemoteLauncher.test.ts`

- [ ] **Step 1: Add launcher tests for stale prompts and timeout behavior**

In `packages/happy-cli/src/claude/claudeInteractiveRemoteLauncher.test.ts`, add these tests before `it('does not forward transcript echoes for prompts sent from the app'...)`:

```ts
it('does not paste a queued batch for a stale prompt in terminal history', async () => {
    const transport = new FakeTerminalTransport('tmux');
    mockCreateTerminalTransport.mockResolvedValue(transport);
    const session = createSession({
        batches: [{
            message: 'queued while busy',
            mode: initialMode,
            hash: 'initial-mode-hash',
            isolate: false,
        }],
    });

    const resultPromise = claudeInteractiveRemoteLauncher(session as any);

    await vi.waitFor(() => {
        expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
    });

    transport.emitData('Claude Code v2.1.153\n❯ Try "old prompt"\nWorking on it...');
    await Promise.resolve();
    expect(transport.paste).not.toHaveBeenCalled();
    expect(session.client.closeClaudeSessionTurn).not.toHaveBeenCalledWith('completed');

    transport.emitData('Claude Code v2.1.153\n❯ Try "new prompt"');

    await vi.waitFor(() => {
        expect(transport.paste).toHaveBeenCalledWith('queued while busy');
        expect(transport.enter).toHaveBeenCalledOnce();
    });

    transport.emitExit({ code: 0, signal: null });
    await resultPromise;
});

it('fails the current turn without pasting when input readiness times out', async () => {
    vi.useFakeTimers();
    try {
        const transport = new FakeTerminalTransport('pty');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession({
            batches: [{
                message: 'do not paste blindly',
                mode: initialMode,
                hash: 'initial-mode-hash',
                isolate: false,
            }],
        });

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });

        await vi.advanceTimersByTimeAsync(8001);

        expect(transport.paste).not.toHaveBeenCalled();
        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Claude interactive terminal is not ready for input yet.',
        });
        expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('failed');
        expect(session.metadataSnapshots()).toContainEqual(expect.objectContaining({
            claudeRuntime: expect.objectContaining({
                state: 'degraded',
                message: 'Claude interactive terminal is not ready for input yet.',
            }),
        }));

        session.enqueueBatch({
            message: 'retry after timeout',
            mode: initialMode,
            hash: 'initial-mode-hash',
            isolate: false,
        });
        transport.emitData('❯ Try "ready now"');

        await vi.waitFor(() => {
            expect(transport.paste).toHaveBeenCalledWith('retry after timeout\r');
        });
        expect(session.metadataSnapshots()).toContainEqual(expect.objectContaining({
            claudeRuntime: expect.objectContaining({
                state: 'interactive',
                message: undefined,
            }),
        }));

        transport.emitExit({ code: 0, signal: null });
        await resultPromise;
    } finally {
        vi.useRealTimers();
    }
});

it('does not report readiness timeout when abort wakes an input wait', async () => {
    const transport = new FakeTerminalTransport('pty');
    mockCreateTerminalTransport.mockResolvedValue(transport);
    const session = createSession({
        batches: [{
            message: 'waiting when aborted',
            mode: initialMode,
            hash: 'initial-mode-hash',
            isolate: false,
        }],
    });

    const resultPromise = claudeInteractiveRemoteLauncher(session as any);

    await vi.waitFor(() => {
        expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
    });

    await session.invokeRpc('abort');

    expect(session.client.sendSessionEvent).not.toHaveBeenCalledWith({
        type: 'message',
        message: 'Claude interactive terminal is not ready for input yet.',
    });
    expect(transport.paste).not.toHaveBeenCalled();
    expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('cancelled');

    session.enqueueBatch({
        message: 'after abort wake',
        mode: initialMode,
        hash: 'initial-mode-hash',
        isolate: false,
    });
    transport.emitData('>');

    await vi.waitFor(() => {
        expect(transport.paste).toHaveBeenCalledWith('after abort wake\r');
    });

    transport.emitExit({ code: 0, signal: null });
    await resultPromise;
});

it('does not report readiness timeout when switch wakes an input wait', async () => {
    const transport = new FakeTerminalTransport('tmux');
    mockCreateTerminalTransport.mockResolvedValue(transport);
    const session = createSession({
        batches: [{
            message: 'waiting when switching local',
            mode: initialMode,
            hash: 'initial-mode-hash',
            isolate: false,
        }],
    });

    const resultPromise = claudeInteractiveRemoteLauncher(session as any);

    await vi.waitFor(() => {
        expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
    });

    await session.invokeRpc('switch');

    expect(session.client.sendSessionEvent).not.toHaveBeenCalledWith({
        type: 'message',
        message: 'Claude interactive terminal is not ready for input yet.',
    });
    expect(transport.paste).not.toHaveBeenCalled();
    expect(session.onModeChange).toHaveBeenCalledWith('local');

    session.enqueueBatch({
        message: 'after switch wake',
        mode: initialMode,
        hash: 'initial-mode-hash',
        isolate: false,
    });
    transport.emitData('>');

    await vi.waitFor(() => {
        expect(transport.detachLocal).toHaveBeenCalledOnce();
        expect(transport.paste).toHaveBeenCalledWith('after switch wake');
    });

    transport.emitExit({ code: 0, signal: null });
    await resultPromise;
});

it('does not report readiness timeout when terminal exit wakes an input wait', async () => {
    const transport = new FakeTerminalTransport('pty');
    mockCreateTerminalTransport.mockResolvedValue(transport);
    const session = createSession({
        batches: [{
            message: 'waiting when terminal exits',
            mode: initialMode,
            hash: 'initial-mode-hash',
            isolate: false,
        }],
    });

    const resultPromise = claudeInteractiveRemoteLauncher(session as any);

    await vi.waitFor(() => {
        expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
    });

    transport.emitExit({ code: 0, signal: null });

    await expect(resultPromise).resolves.toEqual({ type: 'exit', code: 0 });
    expect(transport.paste).not.toHaveBeenCalled();
    expect(session.client.sendSessionEvent).not.toHaveBeenCalledWith({
        type: 'message',
        message: 'Claude interactive terminal is not ready for input yet.',
    });
});
```

- [ ] **Step 2: Run the launcher test and verify the new cases fail**

Run:

```bash
pnpm --filter happy exec vitest run --project unit src/claude/claudeInteractiveRemoteLauncher.test.ts
```

Expected: FAIL. The launcher still treats stale prompt text as ready and still pastes after the timeout.

- [ ] **Step 3: Implement explicit wait results and readiness-helper wiring**

In `packages/happy-cli/src/claude/claudeInteractiveRemoteLauncher.ts`, add the import:

```ts
import { isTerminalInputReady } from './interactive/inputReadiness';
```

Add constants/types near the existing constants:

```ts
const TERMINAL_INPUT_NOT_READY_MESSAGE = 'Claude interactive terminal is not ready for input yet.';
type TerminalInputReadyWaitResult = 'ready' | 'timeout' | 'cancelled' | 'exited';
```

Change the waiter set declaration from:

```ts
const inputReadyWaiters = new Set<() => void>();
```

to:

```ts
const inputReadyWaiters = new Set<(result: TerminalInputReadyWaitResult) => void>();
```

Replace `wakeInputReadyWaiters`, `markTerminalInputReady`, `markTerminalInputBusy`, `cancelPendingInputWaits`, and `waitForTerminalInputReady` with:

```ts
const wakeInputReadyWaiters = (result: TerminalInputReadyWaitResult) => {
    const waiters = [...inputReadyWaiters];
    inputReadyWaiters.clear();
    for (const waiter of waiters) {
        waiter(result);
    }
};

const markTerminalInputReady = () => {
    terminalInputReady = true;
    if (lastSafeTerminalMessage === TERMINAL_INPUT_NOT_READY_MESSAGE) {
        lastSafeTerminalMessage = null;
        updateRuntimeMetadata(session, terminalMetadata('interactive'));
    }
    wakeInputReadyWaiters('ready');
};

const markTerminalInputBusy = () => {
    terminalInputReady = false;
};

const cancelPendingInputWaits = (result: Extract<TerminalInputReadyWaitResult, 'cancelled' | 'exited'> = 'cancelled') => {
    inputCancellationGeneration++;
    wakeInputReadyWaiters(result);
};

const waitForTerminalInputReady = async (): Promise<TerminalInputReadyWaitResult> => {
    if (terminalInputReady) {
        return 'ready';
    }
    if (exitReason) {
        return 'exited';
    }

    return new Promise<TerminalInputReadyWaitResult>((resolve) => {
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const done = (result: TerminalInputReadyWaitResult) => {
            if (timeout) {
                clearTimeout(timeout);
                timeout = null;
            }
            inputReadyWaiters.delete(done);
            resolve(result);
        };

        timeout = setTimeout(() => {
            logger.debug('[interactive-remote]: terminal input readiness timed out; not sending prompt');
            done('timeout');
        }, TERMINAL_INPUT_READY_TIMEOUT_MS);
        inputReadyWaiters.add(done);
    });
};
```

Add this helper near `failRuntime`:

```ts
const failCurrentTurnForInputNotReady = () => {
    updateRuntimeMetadata(session, terminalMetadata('degraded', TERMINAL_INPUT_NOT_READY_MESSAGE));
    if (lastSafeTerminalMessage !== TERMINAL_INPUT_NOT_READY_MESSAGE) {
        lastSafeTerminalMessage = TERMINAL_INPUT_NOT_READY_MESSAGE;
        sendSafeMessage(session, TERMINAL_INPUT_NOT_READY_MESSAGE);
    }
    session.client.closeClaudeSessionTurn('failed');
};
```

In the transport data handler, replace the `case 'input_prompt_visible'` branch with readiness-helper logic. The full handler should have this shape:

```ts
unsubscribeData = transport.onData((data) => {
    const terminalInputIsReady = isTerminalInputReady(data);
    const observation = classifyTerminalOutput(data);

    if (observation) {
        switch (observation.type) {
            case 'spinner_without_transcript':
                markTerminalInputBusy();
                session.onThinkingChange(true);
                return;
            case 'usage_or_auth_error':
            case 'terminal_process_error':
                failRuntime(observation.message);
                return;
            case 'permission_prompt_visible':
                return;
            case 'input_prompt_visible':
                break;
            default: {
                const _: never = observation.type satisfies never;
                return _;
            }
        }
    }

    if (terminalInputIsReady) {
        markTerminalInputReady();
        session.onThinkingChange(false);
        scheduleCompletedTurn();
    }
});
```

In the `transport.onExit` handler, change:

```ts
cancelPendingInputWaits();
```

to:

```ts
cancelPendingInputWaits('exited');
```

In `doExit`, change:

```ts
cancelPendingInputWaits();
```

to:

```ts
cancelPendingInputWaits('exited');
```

In `doSwitch`, add input wait cancellation immediately after `cancelPendingCompletion();`:

```ts
cancelPendingInputWaits('cancelled');
```

In the queued batch loop, replace:

```ts
await waitForTerminalInputReady();
if (writeGeneration !== inputCancellationGeneration || exitReason) {
    continue;
}
```

with:

```ts
const readiness = await waitForTerminalInputReady();
if (writeGeneration !== inputCancellationGeneration || exitReason) {
    continue;
}
if (readiness === 'timeout') {
    cancelPendingCompletion();
    failCurrentTurnForInputNotReady();
    continue;
}
if (readiness !== 'ready') {
    continue;
}
```

- [ ] **Step 4: Run the launcher test and verify it passes**

Run:

```bash
pnpm --filter happy exec vitest run --project unit src/claude/claudeInteractiveRemoteLauncher.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run readiness and launcher tests together**

Run:

```bash
pnpm --filter happy exec vitest run --project unit src/claude/interactive/inputReadiness.test.ts src/claude/claudeInteractiveRemoteLauncher.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

Run:

```bash
git add packages/happy-cli/src/claude/claudeInteractiveRemoteLauncher.ts \
  packages/happy-cli/src/claude/claudeInteractiveRemoteLauncher.test.ts
git commit -m "fix: avoid blind claude terminal prompt paste"
```

---

### Task 4: Make Attachment Upload Logs Privacy-Safe

**Files:**
- Create: `packages/happy-app/sources/sync/attachmentUploadLogging.ts`
- Create: `packages/happy-app/sources/sync/attachmentUploadLogging.test.ts`
- Modify: `packages/happy-app/sources/sync/sync.ts`

- [ ] **Step 1: Write the failing attachment upload logging tests**

Create `packages/happy-app/sources/sync/attachmentUploadLogging.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
    createAttachmentUploadLogMetadata,
    formatAttachmentUploadLogMessage,
} from './attachmentUploadLogging';

describe('attachment upload logging', () => {
    it('formats missing blob key metadata without raw session ids', () => {
        const metadata = createAttachmentUploadLogMetadata({
            phase: 'missing_blob_key',
            attachmentCount: 2,
            sessionId: 'session-secret-123',
        });
        const serialized = JSON.stringify(metadata);

        expect(metadata).toEqual({
            phase: 'missing_blob_key',
            attachmentCount: 2,
        });
        expect(formatAttachmentUploadLogMessage(metadata)).toBe('[attachments] missing_blob_key');
        expect(serialized).not.toContain('session-secret-123');
    });

    it('formats upload failure metadata without raw attachment identifiers or raw error text', () => {
        const error = new Error('failed /Users/devdvlive/private/photo.png with token sk-secret');
        error.name = 'UploadFailed/With Path';

        const metadata = createAttachmentUploadLogMetadata({
            phase: 'upload_failed',
            attachmentIndex: 3,
            attachment: {
                name: 'private-photo.png',
                uri: 'file:///Users/devdvlive/private/photo.png',
                size: 12345,
                width: 640,
                height: 480,
                mimeType: 'image/png',
            },
            error,
            uploadRef: 'blob-ref-secret',
            sessionId: 'session-secret-456',
        });
        const serialized = JSON.stringify(metadata);

        expect(metadata).toEqual({
            phase: 'upload_failed',
            attachmentIndex: 3,
            size: 12345,
            width: 640,
            height: 480,
            errorName: 'UploadFailed_With_Path',
        });
        expect(formatAttachmentUploadLogMessage(metadata)).toBe('[attachments] upload_failed');
        expect(serialized).not.toContain('private-photo.png');
        expect(serialized).not.toContain('file:///Users/devdvlive/private/photo.png');
        expect(serialized).not.toContain('/Users/devdvlive');
        expect(serialized).not.toContain('sk-secret');
        expect(serialized).not.toContain('blob-ref-secret');
        expect(serialized).not.toContain('session-secret-456');
    });

    it('bounds and normalizes errorName', () => {
        const metadata = createAttachmentUploadLogMetadata({
            phase: 'upload_failed',
            error: { name: 'Very Long Error Name With Spaces And Slashes '.repeat(6) },
        });

        expect(metadata.errorName?.length).toBeLessThanOrEqual(80);
        expect(metadata.errorName).toMatch(/^[A-Za-z0-9_.:-]+$/);
    });
});
```

- [ ] **Step 2: Run the attachment logging test and verify it fails**

Run:

```bash
pnpm --dir packages/happy-app test sources/sync/attachmentUploadLogging.test.ts --run
```

Expected: FAIL because `./attachmentUploadLogging` does not exist.

- [ ] **Step 3: Implement the attachment upload logging helper**

Create `packages/happy-app/sources/sync/attachmentUploadLogging.ts`:

```ts
type AttachmentLike = {
    name?: string;
    uri?: string;
    size?: number;
    width?: number;
    height?: number;
    mimeType?: string | null;
};

type AttachmentUploadLogPhase = 'missing_blob_key' | 'upload_failed';

export type AttachmentUploadLogMetadata = {
    phase: AttachmentUploadLogPhase;
    attachmentCount?: number;
    attachmentIndex?: number;
    size?: number;
    width?: number;
    height?: number;
    errorName?: string;
};

export function createAttachmentUploadLogMetadata(input: {
    phase: AttachmentUploadLogPhase;
    attachmentCount?: number;
    attachmentIndex?: number;
    attachment?: AttachmentLike;
    error?: unknown;
    sessionId?: string;
    uploadRef?: string;
}): AttachmentUploadLogMetadata {
    const metadata: AttachmentUploadLogMetadata = {
        phase: input.phase,
    };

    const attachmentCount = input.attachmentCount;
    if (typeof attachmentCount === 'number' && Number.isFinite(attachmentCount)) {
        metadata.attachmentCount = attachmentCount;
    }
    const attachmentIndex = input.attachmentIndex;
    if (typeof attachmentIndex === 'number' && Number.isFinite(attachmentIndex)) {
        metadata.attachmentIndex = attachmentIndex;
    }
    const size = input.attachment?.size;
    if (typeof size === 'number' && Number.isFinite(size)) {
        metadata.size = size;
    }
    const width = input.attachment?.width;
    if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
        metadata.width = width;
    }
    const height = input.attachment?.height;
    if (typeof height === 'number' && Number.isFinite(height) && height > 0) {
        metadata.height = height;
    }

    const errorName = safeErrorName(input.error);
    if (errorName) {
        metadata.errorName = errorName;
    }

    return metadata;
}

export function formatAttachmentUploadLogMessage(metadata: AttachmentUploadLogMetadata): string {
    return `[attachments] ${metadata.phase}`;
}

function safeErrorName(error: unknown): string | undefined {
    if (!error) {
        return undefined;
    }

    const rawName = getRawErrorName(error);
    const normalized = rawName
        .replace(/[^A-Za-z0-9_.:-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);

    return normalized || 'UnknownError';
}

function getRawErrorName(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'name' in error) {
        const name = (error as { name?: unknown }).name;
        if (typeof name === 'string') {
            return name;
        }
    }

    return typeof error;
}
```

- [ ] **Step 4: Wire the helper into sync.ts**

In `packages/happy-app/sources/sync/sync.ts`, add this import near the attachment imports:

```ts
import {
    createAttachmentUploadLogMetadata,
    formatAttachmentUploadLogMessage,
} from './attachmentUploadLogging';
```

Replace:

```ts
console.error(`[attachments] No blob key for session ${sessionId}`);
```

with:

```ts
const metadata = createAttachmentUploadLogMetadata({
    phase: 'missing_blob_key',
    attachmentCount: attachments.length,
    sessionId,
});
console.error(formatAttachmentUploadLogMessage(metadata), metadata);
```

Change the attachment loop from:

```ts
for (const attachment of attachments) {
```

to:

```ts
for (const [attachmentIndex, attachment] of attachments.entries()) {
```

Replace:

```ts
console.error(`[attachments] Failed to upload ${attachment.name}:`, err);
```

with:

```ts
const metadata = createAttachmentUploadLogMetadata({
    phase: 'upload_failed',
    attachmentIndex,
    attachment,
    error: err,
});
console.error(formatAttachmentUploadLogMessage(metadata), metadata);
```

- [ ] **Step 5: Run the attachment logging tests and existing attachment support tests**

Run:

```bash
pnpm --dir packages/happy-app test sources/sync/attachmentUploadLogging.test.ts sources/sync/attachmentSupport.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

Run:

```bash
git add packages/happy-app/sources/sync/attachmentUploadLogging.ts \
  packages/happy-app/sources/sync/attachmentUploadLogging.test.ts \
  packages/happy-app/sources/sync/sync.ts
git commit -m "fix: sanitize attachment upload logs"
```

---

### Task 5: Final Verification

**Files:**
- No code changes expected in this task.

- [ ] **Step 1: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 2: Run focused CLI tests**

Run:

```bash
pnpm --filter happy exec vitest run --project unit \
  src/claude/interactive/terminalTransport.test.ts \
  src/claude/interactive/terminalTransportFactory.test.ts \
  src/claude/interactive/inputReadiness.test.ts \
  src/claude/claudeInteractiveRemoteLauncher.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run focused app tests**

Run:

```bash
pnpm --dir packages/happy-app test \
  sources/sync/attachmentSupport.test.ts \
  sources/sync/attachmentUploadLogging.test.ts \
  --run
```

Expected: PASS.

- [ ] **Step 4: Run full CLI unit suite**

Run:

```bash
pnpm --filter happy exec vitest run --project unit
```

Expected: PASS.

- [ ] **Step 5: Run typechecks**

Run:

```bash
pnpm --filter happy run typecheck
pnpm --filter happy-app run typecheck
```

Expected: both commands PASS.

- [ ] **Step 6: Run manual smoke when Claude auth is available**

Run these in a real local environment with Claude auth available:

```bash
unset TMUX_SESSION_NAME
happy claude --happy-starting-mode remote --started-by daemon
```

Expected: runtime metadata reports PTY backend, a queued text prompt waits for a visible Claude prompt, and auth uses the intended local Claude account/config.

Then run:

```bash
export TMUX_SESSION_NAME=happy
happy claude --happy-starting-mode remote --started-by daemon
```

Expected: runtime metadata reports tmux backend, `CLAUDE_CODE_OAUTH_TOKEN` or local `CLAUDE_CONFIG_DIR` auth works, `switch` can attach locally, and queued text is not pasted while Claude is busy.

- [ ] **Step 7: Commit verification note if any docs changed**

If no files changed during verification, do not commit. If a verification note is added to a doc, commit only that doc:

```bash
git add docs/superpowers/plans/2026-06-15-interactive-claude-remote-release-hardening.md
git commit -m "docs: record interactive claude hardening verification"
```
