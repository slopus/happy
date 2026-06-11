# Interactive Claude Remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Claude remote execution with a real interactive `claude` CLI process controlled through tmux or PTY, with no SDK fallback.

**Architecture:** Keep the Happy controller process separate from the Claude terminal process. The controller owns sync, hooks, queues, and transcript mapping; the terminal backend owns only the real `claude` process. Chat state comes from known Claude JSONL transcripts and existing protocol mapping, while terminal output is reduced to local classified events and sanitized diagnostics.

**Tech Stack:** TypeScript, Vitest, Node child processes, existing tmux utilities, node-pty, Claude JSONL/session scanner, Happy sync metadata, Expo app metadata schema.

---

## File Structure

- Create `packages/happy-cli/src/claude/interactive/types.ts`: shared interactive runtime types, metadata state, terminal event names, transport interfaces.
- Create `packages/happy-cli/src/claude/interactive/sessionIdentity.ts`: resolve `--session-id`, `--resume`, and `--continue` into a concrete Claude session id and launch args.
- Create `packages/happy-cli/src/claude/interactive/sessionIdentity.test.ts`: unit tests for fresh/resume/continue identity.
- Create `packages/happy-cli/src/claude/interactive/inputInjection.ts`: paste-safe terminal input builders and unsupported batch validation.
- Create `packages/happy-cli/src/claude/interactive/inputInjection.test.ts`: multiline, control-character, slash-command, attachment, and mode-change tests.
- Create `packages/happy-cli/src/claude/interactive/terminalObserver.ts`: terminal output classifier and sanitized diagnostic helpers.
- Create `packages/happy-cli/src/claude/interactive/terminalObserver.test.ts`: safe classification and no-raw-output tests.
- Create `packages/happy-cli/src/claude/claudeLocalCommand.ts`: reusable Claude command builder shared by local and interactive remote launch paths.
- Create `packages/happy-cli/src/claude/claudeLocalCommand.test.ts`: regression tests proving MCP, hooks, allowed tools, resume/session-id, env, and sandbox command shape are preserved.
- Modify `packages/happy-cli/src/claude/claudeLocal.ts`: replace inline command construction with `buildClaudeLocalCommand` while keeping current local-mode behavior.
- Modify `packages/happy-cli/src/utils/tmux.ts`: add paste-buffer, capture, resize, interrupt, and target-aware helpers needed by terminal transport.
- Modify `packages/happy-cli/src/utils/tmux.test.ts`: pure tests for tmux command construction and paste behavior.
- Create `packages/happy-cli/src/claude/interactive/terminalTransport.ts`: backend selection plus `TerminalTransport` interface.
- Create `packages/happy-cli/src/claude/interactive/terminalTransportFactory.ts`: runtime factory that selects tmux, PTY, or unsupported based on environment and platform availability.
- Create `packages/happy-cli/src/claude/interactive/tmuxTerminalTransport.ts`: tmux-backed Claude terminal transport with target-aware paste and bounded capture polling for local-only terminal observations.
- Create `packages/happy-cli/src/claude/interactive/ptyTerminalTransport.ts`: direct PTY transport using `node-pty`.
- Create `packages/happy-cli/src/claude/interactive/terminalTransport.test.ts`: backend selection, remote-only PTY, and lifecycle tests with mocked backends.
- Create `packages/happy-cli/src/claude/claudeInteractiveRemoteLauncher.ts`: main interactive remote launcher.
- Create `packages/happy-cli/src/claude/claudeInteractiveRemoteLauncher.test.ts`: launcher behavior with fake transport and fake scanner.
- Modify `packages/happy-cli/src/claude/loop.ts`: route Claude remote mode to `claudeInteractiveRemoteLauncher`.
- Modify `packages/happy-cli/src/claude/session.ts`: carry initial interactive mode and runtime metadata helpers.
- Modify `packages/happy-cli/src/claude/runClaude.ts`: pass initial mode, expose interactive runtime metadata, keep attachment downloads from being silently sent.
- Modify `packages/happy-cli/src/daemon/run.ts`: for Claude interactive remote, do not put the Happy controller in tmux; reserve tmux for Claude terminal.
- Create `packages/happy-cli/src/daemon/run.interactiveClaude.test.ts`: daemon ownership regression test.
- Modify `packages/happy-cli/package.json`: add `node-pty` dependency for happy-cli direct PTY backend.
- Modify `packages/happy-app/sources/sync/storageTypes.ts`: include interactive Claude runtime metadata in decrypted metadata schema.
- Modify `packages/happy-cli/src/api/types.ts`: include the same metadata type on the CLI side.
- Create `packages/happy-app/sources/sync/attachmentSupport.ts`: app-side attachment capability helper based on session metadata.
- Create `packages/happy-app/sources/sync/attachmentSupport.test.ts`: focused tests for Claude interactive remote attachment gating.
- Modify `packages/happy-app/sources/sync/sync.ts`: block image/file attachments when session metadata says Claude is running in interactive remote.
- Modify `packages/happy-app/sources/text/_default.ts` and `packages/happy-app/sources/text/translations/en.ts`: add interactive-remote attachment unsupported copy.

## Implementation Notes

- Work only in `/Users/devdvlive/Projects/happy-worktrees/interactive-claude-remote`.
- Use TDD for every new helper and launcher boundary.
- Commit after each task.
- Do not remove `claudeRemote.ts` in the first pass; quarantine it behind an explicit internal flag only after interactive runtime is wired.
- Do not log raw terminal bytes, raw attachment names, refs, session ids, cache paths, URLs, or raw `Error` objects.
- Use `git diff --check` before every commit.

### Task 1: Add Metadata And Runtime Types

**Files:**
- Create: `packages/happy-cli/src/claude/interactive/types.ts`
- Modify: `packages/happy-cli/src/api/types.ts`
- Modify: `packages/happy-app/sources/sync/storageTypes.ts`

- [ ] **Step 1: Create shared interactive runtime types**

Create `packages/happy-cli/src/claude/interactive/types.ts`:

```ts
import type { EnhancedMode } from '@/claude/loop';
import type { PendingAttachment } from '@/utils/MessageQueue2';

export type InteractiveClaudeRuntimeState =
    | 'starting'
    | 'interactive'
    | 'degraded'
    | 'unsupported'
    | 'failed';

export type InteractiveClaudeTerminalBackend = 'tmux' | 'pty';

export type InteractiveClaudeTerminalCapability =
    | 'remote-control'
    | 'local-attach';

export type InteractiveClaudeTerminalEvent =
    | 'permission_prompt_visible'
    | 'input_prompt_visible'
    | 'usage_or_auth_error'
    | 'spinner_without_transcript'
    | 'terminal_process_error';

export interface InteractiveClaudeRuntimeMetadata {
    kind: 'interactive';
    state: InteractiveClaudeRuntimeState;
    backend?: InteractiveClaudeTerminalBackend;
    capabilities?: InteractiveClaudeTerminalCapability[];
    claudeSessionId?: string;
    terminalId?: string;
    message?: string;
    updatedAt: number;
}

export interface InteractiveClaudeBatch {
    message: string;
    mode: EnhancedMode;
    hash: string;
    isolate: boolean;
    attachments?: PendingAttachment[];
}

export type InteractiveClaudeUnsupportedReason =
    | 'attachments'
    | 'mode-change'
    | 'control-character'
    | 'empty-message';

export type InteractiveClaudeBatchValidation =
    | { ok: true }
    | { ok: false; reason: InteractiveClaudeUnsupportedReason; message: string };
```

- [ ] **Step 2: Add CLI metadata field**

In `packages/happy-cli/src/api/types.ts`, add this property to `Metadata` near `claudeSessionId`:

```ts
  claudeRuntime?: {
    kind: 'interactive' | 'sdk' | string
    state?: 'starting' | 'interactive' | 'degraded' | 'unsupported' | 'failed' | string
    backend?: 'tmux' | 'pty' | string
    capabilities?: string[]
    claudeSessionId?: string
    terminalId?: string
    message?: string
    updatedAt?: number
  },
```

- [ ] **Step 3: Add app metadata schema field**

In `packages/happy-app/sources/sync/storageTypes.ts`, add this field to `MetadataSchema` near `claudeSessionId`:

```ts
    claudeRuntime: z.object({
        kind: z.string(),
        state: z.string().optional(),
        backend: z.string().optional(),
        capabilities: z.array(z.string()).optional(),
        claudeSessionId: z.string().optional(),
        terminalId: z.string().optional(),
        message: z.string().optional(),
        updatedAt: z.number().optional(),
    }).optional(),
```

- [ ] **Step 4: Run typecheck**

Run:

```bash
pnpm --dir packages/happy-cli typecheck
pnpm --dir packages/happy-app typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/claude/interactive/types.ts \
  packages/happy-cli/src/api/types.ts \
  packages/happy-app/sources/sync/storageTypes.ts
git commit -m "feat: add interactive claude runtime metadata"
```

### Task 2: Resolve Claude Session Identity And Paste Input

**Files:**
- Create: `packages/happy-cli/src/claude/interactive/sessionIdentity.ts`
- Create: `packages/happy-cli/src/claude/interactive/sessionIdentity.test.ts`
- Create: `packages/happy-cli/src/claude/interactive/inputInjection.ts`
- Create: `packages/happy-cli/src/claude/interactive/inputInjection.test.ts`

- [ ] **Step 1: Write failing session identity tests**

Create `packages/happy-cli/src/claude/interactive/sessionIdentity.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { resolveInteractiveClaudeIdentity } from './sessionIdentity';

describe('resolveInteractiveClaudeIdentity', () => {
    it('generates a fresh session id and --session-id args when no resume flags are present', () => {
        const result = resolveInteractiveClaudeIdentity({
            workingDirectory: '/repo',
            claudeArgs: ['--model', 'opus'],
            generateId: () => '11111111-1111-4111-8111-111111111111',
            findLastSession: vi.fn(),
        });

        expect(result).toEqual({
            claudeSessionId: '11111111-1111-4111-8111-111111111111',
            launchArgs: ['--session-id', '11111111-1111-4111-8111-111111111111', '--model', 'opus'],
            consumedArgs: ['--model', 'opus'],
            mode: 'fresh',
        });
    });

    it('uses explicit --resume uuid and removes the resume flag from passthrough args', () => {
        const result = resolveInteractiveClaudeIdentity({
            workingDirectory: '/repo',
            claudeArgs: ['--resume', '22222222-2222-4222-8222-222222222222', '--model', 'sonnet'],
            generateId: () => 'unused',
            findLastSession: vi.fn(),
        });

        expect(result.claudeSessionId).toBe('22222222-2222-4222-8222-222222222222');
        expect(result.launchArgs).toEqual(['--resume', '22222222-2222-4222-8222-222222222222', '--model', 'sonnet']);
        expect(result.consumedArgs).toEqual(['--model', 'sonnet']);
        expect(result.mode).toBe('resume');
    });

    it('resolves --continue to the latest concrete local session id', () => {
        const result = resolveInteractiveClaudeIdentity({
            workingDirectory: '/repo',
            claudeArgs: ['--continue'],
            generateId: () => 'unused',
            findLastSession: () => '33333333-3333-4333-8333-333333333333',
        });

        expect(result.launchArgs).toEqual(['--resume', '33333333-3333-4333-8333-333333333333']);
        expect(result.mode).toBe('continue');
    });

    it('uses explicit --session-id once when provided', () => {
        const result = resolveInteractiveClaudeIdentity({
            workingDirectory: '/repo',
            claudeArgs: ['--session-id', '44444444-4444-4444-8444-444444444444', '--model', 'opus'],
            generateId: () => 'unused',
            findLastSession: vi.fn(),
        });

        expect(result).toEqual({
            claudeSessionId: '44444444-4444-4444-8444-444444444444',
            launchArgs: ['--session-id', '44444444-4444-4444-8444-444444444444', '--model', 'opus'],
            consumedArgs: ['--model', 'opus'],
            mode: 'fresh',
        });
    });

    it('returns unsupported when --continue has no local session', () => {
        const result = resolveInteractiveClaudeIdentity({
            workingDirectory: '/repo',
            claudeArgs: ['--continue'],
            generateId: () => 'unused',
            findLastSession: () => null,
        });

        expect(result).toEqual({
            error: 'No local Claude session found for --continue.',
            mode: 'unsupported',
        });
    });
});
```

- [ ] **Step 2: Write failing input injection tests**

Create `packages/happy-cli/src/claude/interactive/inputInjection.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildInteractivePaste, validateInteractiveBatch } from './inputInjection';

const mode = { permissionMode: 'default' as const, model: 'opus' };

describe('buildInteractivePaste', () => {
    it('sends single-line prompts as text plus carriage return', () => {
        expect(buildInteractivePaste('hello', 'pty')).toBe('hello\r');
    });

    it('wraps multiline PTY prompts in bracketed paste before enter', () => {
        expect(buildInteractivePaste('a\nb', 'pty')).toBe('\x1b[200~a\nb\x1b[201~\r');
    });

    it('normalizes CRLF before paste', () => {
        expect(buildInteractivePaste('a\r\nb', 'pty')).toBe('\x1b[200~a\nb\x1b[201~\r');
    });

    it('returns tmux paste text without bracket escape bytes', () => {
        expect(buildInteractivePaste('a\nb', 'tmux')).toBe('a\nb');
    });
});

describe('validateInteractiveBatch', () => {
    it('rejects attachments before terminal write', () => {
        expect(validateInteractiveBatch({
            batch: {
                message: 'describe this',
                mode,
                hash: 'h1',
                isolate: false,
                attachments: [{ data: new Uint8Array([1]), mimeType: 'image/png', name: 'x.png' }],
            },
            launchModeHash: 'h1',
        })).toEqual({
            ok: false,
            reason: 'attachments',
            message: 'Claude interactive remote does not support image or file attachments yet.',
        });
    });

    it('rejects mid-session mode changes', () => {
        expect(validateInteractiveBatch({
            batch: { message: 'hi', mode, hash: 'h2', isolate: false },
            launchModeHash: 'h1',
        })).toEqual({
            ok: false,
            reason: 'mode-change',
            message: 'Claude interactive remote cannot change model, effort, tools, prompts, or sandbox settings inside a running session.',
        });
    });

    it('rejects non-newline control characters', () => {
        expect(validateInteractiveBatch({
            batch: { message: 'bad\u0000input', mode, hash: 'h1', isolate: false },
            launchModeHash: 'h1',
        })).toMatchObject({ ok: false, reason: 'control-character' });
    });

    it('allows slash commands only when the entire message is the command', () => {
        expect(validateInteractiveBatch({
            batch: { message: '/clear', mode, hash: 'h1', isolate: true },
            launchModeHash: 'h1',
        })).toEqual({ ok: true });
    });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit \
  src/claude/interactive/sessionIdentity.test.ts \
  src/claude/interactive/inputInjection.test.ts
```

Expected: FAIL because implementation files do not exist.

- [ ] **Step 4: Implement session identity**

Create `packages/happy-cli/src/claude/interactive/sessionIdentity.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { claudeFindLastSession } from '@/claude/utils/claudeFindLastSession';

type ResolveInput = {
    workingDirectory: string;
    claudeArgs?: string[];
    generateId?: () => string;
    findLastSession?: (workingDirectory: string) => string | null;
};

type ResolveResult =
    | {
        claudeSessionId: string;
        launchArgs: string[];
        consumedArgs: string[];
        mode: 'fresh' | 'resume' | 'continue';
    }
    | {
        error: string;
        mode: 'unsupported';
    };

export function resolveInteractiveClaudeIdentity(input: ResolveInput): ResolveResult {
    const args = [...(input.claudeArgs ?? [])];
    const generateId = input.generateId ?? randomUUID;
    const findLastSession = input.findLastSession ?? claudeFindLastSession;
    const consumedArgs: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if ((arg === '--resume' || arg === '-r') && args[i + 1] && !args[i + 1].startsWith('-')) {
            const claudeSessionId = args[i + 1];
            consumedArgs.push(...args.slice(0, i), ...args.slice(i + 2));
            return {
                claudeSessionId,
                launchArgs: ['--resume', claudeSessionId, ...consumedArgs],
                consumedArgs,
                mode: 'resume',
            };
        }
        if (arg.startsWith('--resume=')) {
            const claudeSessionId = arg.slice('--resume='.length);
            consumedArgs.push(...args.slice(0, i), ...args.slice(i + 1));
            return {
                claudeSessionId,
                launchArgs: ['--resume', claudeSessionId, ...consumedArgs],
                consumedArgs,
                mode: 'resume',
            };
        }
        if (arg === '--continue' || arg === '-c') {
            const claudeSessionId = findLastSession(input.workingDirectory);
            if (!claudeSessionId) {
                return { error: 'No local Claude session found for --continue.', mode: 'unsupported' };
            }
            consumedArgs.push(...args.slice(0, i), ...args.slice(i + 1));
            return {
                claudeSessionId,
                launchArgs: ['--resume', claudeSessionId, ...consumedArgs],
                consumedArgs,
                mode: 'continue',
            };
        }
        if (arg === '--session-id' && args[i + 1] && !args[i + 1].startsWith('-')) {
            const claudeSessionId = args[i + 1];
            consumedArgs.push(...args.slice(0, i), ...args.slice(i + 2));
            return {
                claudeSessionId,
                launchArgs: ['--session-id', claudeSessionId, ...consumedArgs],
                consumedArgs,
                mode: 'fresh',
            };
        }
        if (arg.startsWith('--session-id=')) {
            const claudeSessionId = arg.slice('--session-id='.length);
            consumedArgs.push(...args.slice(0, i), ...args.slice(i + 1));
            return {
                claudeSessionId,
                launchArgs: ['--session-id', claudeSessionId, ...consumedArgs],
                consumedArgs,
                mode: 'fresh',
            };
        }
    }

    const claudeSessionId = generateId();
    return {
        claudeSessionId,
        launchArgs: ['--session-id', claudeSessionId, ...args],
        consumedArgs: args,
        mode: 'fresh',
    };
}
```

- [ ] **Step 5: Implement paste and batch validation**

Create `packages/happy-cli/src/claude/interactive/inputInjection.ts`:

```ts
import type {
    InteractiveClaudeBatch,
    InteractiveClaudeBatchValidation,
    InteractiveClaudeTerminalBackend,
} from './types';

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

export function normalizePromptText(message: string): string {
    return message.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function hasUnsupportedControlCharacter(message: string): boolean {
    for (const ch of message) {
        const code = ch.charCodeAt(0);
        if (code < 0x20 && ch !== '\n' && ch !== '\t') {
            return true;
        }
    }
    return false;
}

export function buildInteractivePaste(message: string, backend: InteractiveClaudeTerminalBackend): string {
    const normalized = normalizePromptText(message);
    if (backend === 'tmux') {
        return normalized;
    }
    if (normalized.includes('\n')) {
        return `${BRACKETED_PASTE_START}${normalized}${BRACKETED_PASTE_END}\r`;
    }
    return `${normalized}\r`;
}

export function validateInteractiveBatch(input: {
    batch: InteractiveClaudeBatch;
    launchModeHash: string;
}): InteractiveClaudeBatchValidation {
    const message = normalizePromptText(input.batch.message);
    if (message.trim().length === 0 && !message.startsWith('/')) {
        return { ok: false, reason: 'empty-message', message: 'Claude interactive remote cannot send an empty prompt.' };
    }
    if (input.batch.attachments && input.batch.attachments.length > 0) {
        return { ok: false, reason: 'attachments', message: 'Claude interactive remote does not support image or file attachments yet.' };
    }
    if (input.batch.hash !== input.launchModeHash) {
        return {
            ok: false,
            reason: 'mode-change',
            message: 'Claude interactive remote cannot change model, effort, tools, prompts, or sandbox settings inside a running session.',
        };
    }
    if (hasUnsupportedControlCharacter(message)) {
        return { ok: false, reason: 'control-character', message: 'Claude interactive remote cannot send prompts with raw control characters.' };
    }
    if (message.includes('\n') && message.trimStart().startsWith('/')) {
        return { ok: false, reason: 'control-character', message: 'Claude slash commands must be sent as a single command line.' };
    }
    return { ok: true };
}
```

- [ ] **Step 6: Run tests**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit \
  src/claude/interactive/sessionIdentity.test.ts \
  src/claude/interactive/inputInjection.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/happy-cli/src/claude/interactive/sessionIdentity.ts \
  packages/happy-cli/src/claude/interactive/sessionIdentity.test.ts \
  packages/happy-cli/src/claude/interactive/inputInjection.ts \
  packages/happy-cli/src/claude/interactive/inputInjection.test.ts
git commit -m "feat: add interactive claude input contracts"
```

### Task 3: Add Terminal Observer And Safe Diagnostics

**Files:**
- Create: `packages/happy-cli/src/claude/interactive/terminalObserver.ts`
- Create: `packages/happy-cli/src/claude/interactive/terminalObserver.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/happy-cli/src/claude/interactive/terminalObserver.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyTerminalOutput, sanitizeTerminalDiagnostic } from './terminalObserver';

describe('classifyTerminalOutput', () => {
    it('detects usage/auth errors without returning raw output', () => {
        expect(classifyTerminalOutput('Claude AI usage limit reached|1799999999')).toEqual({
            type: 'usage_or_auth_error',
            message: 'Claude reported a usage or authentication problem.',
        });
    });

    it('detects permission prompts', () => {
        expect(classifyTerminalOutput('Do you want to allow Bash?')).toEqual({
            type: 'permission_prompt_visible',
            message: 'Claude is asking for permission.',
        });
    });

    it('returns null for ordinary output', () => {
        expect(classifyTerminalOutput('Working on it...')).toBeNull();
    });
});

describe('sanitizeTerminalDiagnostic', () => {
    it('redacts paths, URLs, and token-like strings', () => {
        expect(sanitizeTerminalDiagnostic('failed /Users/me/secret sk-ant-api03-abc https://example.com/x')).toBe(
            'failed [path] [secret] [url]',
        );
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit src/claude/interactive/terminalObserver.test.ts
```

Expected: FAIL because `terminalObserver.ts` does not exist.

- [ ] **Step 3: Implement classifier and sanitizer**

Create `packages/happy-cli/src/claude/interactive/terminalObserver.ts`:

```ts
import type { InteractiveClaudeTerminalEvent } from './types';

export type TerminalObservation = {
    type: InteractiveClaudeTerminalEvent;
    message: string;
};

export function sanitizeTerminalDiagnostic(input: string): string {
    return input
        .replace(/https?:\/\/\S+/g, '[url]')
        .replace(/\b(?:sk|sk-ant|claude)[-_A-Za-z0-9]{12,}\b/g, '[secret]')
        .replace(/(?:\/Users|\/home|\/private\/tmp|[A-Za-z]:\\)[^\s]+/g, '[path]')
        .slice(0, 240);
}

export function classifyTerminalOutput(raw: string): TerminalObservation | null {
    const text = sanitizeTerminalDiagnostic(raw);
    if (/usage limit|authentication|auth error|login required|not logged in/i.test(raw)) {
        return { type: 'usage_or_auth_error', message: 'Claude reported a usage or authentication problem.' };
    }
    if (/allow .*?\?|permission|approve/i.test(raw)) {
        return { type: 'permission_prompt_visible', message: 'Claude is asking for permission.' };
    }
    if (/esc to interrupt|tokens remaining|thinking\.\.\./i.test(raw) && !/error/i.test(raw)) {
        return { type: 'spinner_without_transcript', message: 'Claude is running but has not written transcript output yet.' };
    }
    if (/^\s*[>❯]\s*$/.test(raw) || /input/i.test(raw)) {
        return { type: 'input_prompt_visible', message: 'Claude appears ready for input.' };
    }
    if (/error|failed|exception/i.test(raw)) {
        return { type: 'terminal_process_error', message: text || 'Claude terminal reported an error.' };
    }
    return null;
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit src/claude/interactive/terminalObserver.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/claude/interactive/terminalObserver.ts \
  packages/happy-cli/src/claude/interactive/terminalObserver.test.ts
git commit -m "feat: add safe claude terminal observations"
```

### Task 4: Extract Reusable Claude Command Builder

**Files:**
- Create: `packages/happy-cli/src/claude/claudeLocalCommand.ts`
- Create: `packages/happy-cli/src/claude/claudeLocalCommand.test.ts`
- Modify: `packages/happy-cli/src/claude/claudeLocal.ts`

- [ ] **Step 1: Write failing command builder tests**

Create `packages/happy-cli/src/claude/claudeLocalCommand.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/projectPath', () => ({ projectPath: () => '/repo-root' }));
vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    return { ...actual, existsSync: vi.fn(() => true) };
});
vi.mock('@/sandbox/manager', () => ({
    initializeSandbox: vi.fn(async () => vi.fn(async () => {})),
    wrapCommand: vi.fn(async (command: string) => `sandbox ${command}`),
}));
vi.mock('./utils/proxyBypass', () => ({ ensureLocalProxyBypass: vi.fn() }));
vi.mock('./utils/systemPrompt', () => ({ systemPrompt: 'HAPPY_SYSTEM_PROMPT' }));

import { buildClaudeLocalCommand } from './claudeLocalCommand';

describe('buildClaudeLocalCommand', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('preserves session, system prompt, MCP, allowed tools, hooks, cwd, and env', async () => {
        const built = await buildClaudeLocalCommand({
            path: '/work',
            baseClaudeArgs: ['--session-id', '11111111-1111-4111-8111-111111111111', '--model', 'opus'],
            mcpServers: { happy: { type: 'http', url: 'http://127.0.0.1:3000' } },
            allowedTools: ['mcp__happy__edit'],
            hookSettingsPath: '/tmp/hook-settings.json',
            claudeEnvVars: { FOO: 'bar' },
        });

        expect(built.command).toBe('node');
        expect(built.args).toEqual([
            '/repo-root/scripts/claude_local_launcher.cjs',
            '--session-id',
            '11111111-1111-4111-8111-111111111111',
            '--model',
            'opus',
            '--append-system-prompt',
            'HAPPY_SYSTEM_PROMPT',
            '--mcp-config',
            JSON.stringify({ mcpServers: { happy: { type: 'http', url: 'http://127.0.0.1:3000' } } }),
            '--allowedTools',
            'mcp__happy__edit',
            '--settings',
            '/tmp/hook-settings.json',
        ]);
        expect(built.cwd).toBe('/work');
        expect(built.env.FOO).toBe('bar');
        expect(built.shell).toBe(false);
    });

    it('wraps sandboxed commands and adds skip-permissions once', async () => {
        const built = await buildClaudeLocalCommand({
            path: '/work',
            baseClaudeArgs: ['--resume', '22222222-2222-4222-8222-222222222222'],
            sandboxConfig: { enabled: true, workspaceRoot: '/work', networkMode: 'off' } as any,
        });

        expect(built.command).toContain('sandbox node');
        expect(built.args).toEqual([]);
        expect(built.shell).toBe(true);
        expect(built.cleanupSandbox).toBeTypeOf('function');
        expect(built.unwrappedArgs).toContain('--dangerously-skip-permissions');
        expect(built.unwrappedArgs.filter((arg) => arg === '--dangerously-skip-permissions')).toHaveLength(1);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit src/claude/claudeLocalCommand.test.ts
```

Expected: FAIL because `claudeLocalCommand.ts` does not exist.

- [ ] **Step 3: Implement the command builder**

Create `packages/happy-cli/src/claude/claudeLocalCommand.ts`:

```ts
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { projectPath } from '@/projectPath';
import { initializeSandbox, wrapCommand } from '@/sandbox/manager';
import type { SandboxConfig } from '@/persistence';
import { ensureLocalProxyBypass } from './utils/proxyBypass';
import { systemPrompt } from './utils/systemPrompt';

export const claudeCliPath = resolve(join(projectPath(), 'scripts', 'claude_local_launcher.cjs'));

function quoteShellArg(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

export type BuiltClaudeLocalCommand = {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    shell: boolean;
    unwrappedArgs: string[];
    cleanupSandbox: (() => Promise<void>) | null;
};

export async function buildClaudeLocalCommand(opts: {
    path: string;
    baseClaudeArgs: string[];
    mcpServers?: Record<string, any>;
    allowedTools?: string[];
    hookSettingsPath?: string;
    claudeEnvVars?: Record<string, string>;
    sandboxConfig?: SandboxConfig;
}): Promise<BuiltClaudeLocalCommand> {
    if (!claudeCliPath || !existsSync(claudeCliPath)) {
        throw new Error('Claude local launcher not found. Please ensure HAPPY_PROJECT_ROOT is set correctly for development.');
    }

    const claudeArgs = [...opts.baseClaudeArgs, '--append-system-prompt', systemPrompt];

    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
        claudeArgs.push('--mcp-config', JSON.stringify({ mcpServers: opts.mcpServers }));
    }

    if (opts.allowedTools && opts.allowedTools.length > 0) {
        claudeArgs.push('--allowedTools', opts.allowedTools.join(','));
    }

    if (opts.hookSettingsPath) {
        claudeArgs.push('--settings', opts.hookSettingsPath);
    }

    const env = { ...process.env, ...(opts.claudeEnvVars ?? {}) } as Record<string, string>;
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
        ensureLocalProxyBypass(env);
    }

    let cleanupSandbox: (() => Promise<void>) | null = null;
    let unwrappedArgs = [claudeCliPath, ...claudeArgs];

    if (opts.sandboxConfig?.enabled && process.platform !== 'win32') {
        cleanupSandbox = await initializeSandbox(opts.sandboxConfig, opts.path);
        if (!unwrappedArgs.includes('--dangerously-skip-permissions')) {
            unwrappedArgs = [...unwrappedArgs, '--dangerously-skip-permissions'];
        }
        const fullCommand = ['node', ...unwrappedArgs.map((arg) => quoteShellArg(arg))].join(' ');
        return {
            command: await wrapCommand(fullCommand),
            args: [],
            cwd: opts.path,
            env,
            shell: true,
            unwrappedArgs,
            cleanupSandbox,
        };
    }

    return {
        command: 'node',
        args: unwrappedArgs,
        cwd: opts.path,
        env,
        shell: false,
        unwrappedArgs,
        cleanupSandbox,
    };
}
```

- [ ] **Step 4: Refactor local launcher to use builder**

In `packages/happy-cli/src/claude/claudeLocal.ts`, keep the existing session flag extraction through `effectiveSessionId`, then replace the inline command/env/sandbox construction inside the spawn block with:

```ts
const baseClaudeArgs: string[] = [];
if (!opts.hookSettingsPath) {
    const hasResumeFlag = opts.claudeArgs?.includes('--resume') || opts.claudeArgs?.includes('-r');
    if (startFrom) {
        baseClaudeArgs.push('--resume', startFrom);
    } else if (!hasResumeFlag && newSessionId) {
        baseClaudeArgs.push('--session-id', newSessionId);
    }
} else if (startFrom) {
    baseClaudeArgs.push('--resume', startFrom);
}
if (opts.claudeArgs) {
    baseClaudeArgs.push(...opts.claudeArgs);
}

const built = await buildClaudeLocalCommand({
    path: opts.path,
    baseClaudeArgs,
    mcpServers: opts.mcpServers,
    allowedTools: opts.allowedTools,
    hookSettingsPath: opts.hookSettingsPath,
    claudeEnvVars: opts.claudeEnvVars,
    sandboxConfig: opts.sandboxConfig,
});

cleanupSandbox = built.cleanupSandbox;
const child = crossSpawn(built.command, built.args, {
    stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
    signal: opts.abort,
    cwd: built.cwd,
    env: built.env,
    shell: built.shell,
    windowsHide: true,
});
```

Remove the old local `claudeCliPath`, `quoteShellArg`, `existsSync`, `ensureLocalProxyBypass`, `systemPrompt`, `initializeSandbox`, and `wrapCommand` imports from `claudeLocal.ts`, and import:

```ts
import { buildClaudeLocalCommand } from './claudeLocalCommand';
export { claudeCliPath } from './claudeLocalCommand';
```

Keep the re-export in `claudeLocal.ts` so existing imports such as `packages/happy-cli/src/index.ts` continue to compile.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit src/claude/claudeLocalCommand.test.ts
pnpm --dir packages/happy-cli typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/happy-cli/src/claude/claudeLocalCommand.ts \
  packages/happy-cli/src/claude/claudeLocalCommand.test.ts \
  packages/happy-cli/src/claude/claudeLocal.ts
git commit -m "feat: share claude command builder"
```

### Task 5: Build Terminal Transport Backends

**Files:**
- Modify: `packages/happy-cli/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/happy-cli/src/utils/tmux.ts`
- Modify: `packages/happy-cli/src/utils/tmux.test.ts`
- Create: `packages/happy-cli/src/claude/interactive/terminalTransport.ts`
- Create: `packages/happy-cli/src/claude/interactive/tmuxTerminalTransport.ts`
- Create: `packages/happy-cli/src/claude/interactive/ptyTerminalTransport.ts`
- Create: `packages/happy-cli/src/claude/interactive/terminalTransport.test.ts`

- [ ] **Step 1: Add happy-cli node-pty dependency**

Run:

```bash
pnpm --filter happy add node-pty@^1.1.0
```

Expected: `packages/happy-cli/package.json` and `pnpm-lock.yaml` update.

- [ ] **Step 2: Add tmux paste tests**

Change the import in `packages/happy-cli/src/utils/tmux.test.ts` to include `vi`:

```ts
import { describe, expect, it, vi } from 'vitest';
```

Append to the same file:

```ts
describe('TmuxUtilities paste helpers', () => {
    it('builds paste-buffer commands without putting raw text in send-keys', async () => {
        const commands: string[][] = [];
        const tmux = new TmuxUtilities('happy-test');
        vi.spyOn(tmux as any, 'executeTmuxCommand').mockImplementation(async (args: string[]) => {
            commands.push(args);
            return { returncode: 0, stdout: '', stderr: '', command: ['tmux', ...args] };
        });

        await tmux.pasteText('line 1\nline 2', 'happy-test', 'window-1');

        expect(commands[0]).toEqual(expect.arrayContaining(['set-buffer']));
        expect(commands[1]).toEqual(expect.arrayContaining(['paste-buffer']));
        expect(commands[1]).toEqual(['paste-buffer', '-b', expect.stringMatching(/^happy-paste-/)]);
    });

    it('targets resize-pane at the requested pane', async () => {
        const commands: string[][] = [];
        const tmux = new TmuxUtilities('happy-test');
        vi.spyOn(tmux as any, 'executeCommand').mockImplementation(async (args: string[]) => {
            commands.push(args);
            return { exitCode: 0, stdout: '', stderr: '' };
        });

        await tmux.resizePane(120, 30, 'happy-test', 'window-1', '2');

        expect(commands[0]).toEqual(['tmux', 'resize-pane', '-x', '120', '-y', '30', '-t', 'happy-test:window-1.2']);
    });
});
```

- [ ] **Step 3: Extend tmux utilities**

In `packages/happy-cli/src/utils/tmux.ts`, add `'paste-buffer'` and `'resize-pane'` to `COMMANDS_SUPPORTING_TARGET`.

Then add methods to `TmuxUtilities`:

```ts
    async pasteText(text: string, session?: string, window?: string, pane?: string): Promise<boolean> {
        const bufferName = `happy-paste-${Date.now()}`;
        const setResult = await this.executeTmuxCommand(['set-buffer', '-b', bufferName, text]);
        if (!setResult || setResult.returncode !== 0) {
            return false;
        }
        const pasteResult = await this.executeTmuxCommand(['paste-buffer', '-b', bufferName], session, window, pane);
        await this.executeTmuxCommand(['delete-buffer', '-b', bufferName], session, window, pane);
        return pasteResult !== null && pasteResult.returncode === 0;
    }

    async resizePane(cols: number, rows: number, session?: string, window?: string, pane?: string): Promise<boolean> {
        const result = await this.executeTmuxCommand(['resize-pane', '-x', String(cols), '-y', String(rows)], session, window, pane);
        return result !== null && result.returncode === 0;
    }

    async capturePaneText(session?: string, window?: string, pane?: string): Promise<string> {
        const result = await this.executeTmuxCommand(['capture-pane', '-p'], session, window, pane);
        return result && result.returncode === 0 ? result.stdout : '';
    }
```

- [ ] **Step 4: Create transport interface**

Create `packages/happy-cli/src/claude/interactive/terminalTransport.ts`:

```ts
import type { InteractiveClaudeTerminalBackend, InteractiveClaudeTerminalCapability } from './types';

export type TerminalSpawnOptions = {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    shell?: boolean;
    windowName: string;
};

export type TerminalExit = {
    code: number | null;
    signal?: string | null;
};

export interface TerminalTransport {
    readonly backend: InteractiveClaudeTerminalBackend;
    readonly terminalId: string | null;
    readonly capabilities: InteractiveClaudeTerminalCapability[];
    spawn(options: TerminalSpawnOptions): Promise<{ pid?: number; terminalId: string }>;
    paste(text: string): Promise<void>;
    enter(): Promise<void>;
    interrupt(): Promise<void>;
    resize(cols: number, rows: number): Promise<void>;
    onData(callback: (chunk: string) => void): () => void;
    onExit(callback: (exit: TerminalExit) => void): () => void;
    dispose(): Promise<void>;
}

export type TerminalBackendAvailability = {
    tmuxConfigured: boolean;
    tmuxAvailable: boolean;
    ptyAvailable: boolean;
};

export function chooseTerminalBackend(availability: TerminalBackendAvailability): InteractiveClaudeTerminalBackend | 'unsupported' {
    if (availability.tmuxConfigured && availability.tmuxAvailable) return 'tmux';
    if (availability.ptyAvailable) return 'pty';
    return 'unsupported';
}
```

- [ ] **Step 5: Add backend selection tests**

Create `packages/happy-cli/src/claude/interactive/terminalTransport.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { chooseTerminalBackend } from './terminalTransport';
import { PtyTerminalTransport } from './ptyTerminalTransport';
import { TmuxTerminalTransport } from './tmuxTerminalTransport';

describe('chooseTerminalBackend', () => {
    it('prefers configured tmux when available', () => {
        expect(chooseTerminalBackend({ tmuxConfigured: true, tmuxAvailable: true, ptyAvailable: true })).toBe('tmux');
    });

    it('uses direct PTY when tmux is not configured', () => {
        expect(chooseTerminalBackend({ tmuxConfigured: false, tmuxAvailable: true, ptyAvailable: true })).toBe('pty');
    });

    it('returns unsupported when neither backend is available', () => {
        expect(chooseTerminalBackend({ tmuxConfigured: false, tmuxAvailable: false, ptyAvailable: false })).toBe('unsupported');
    });
});

describe('terminal transport capabilities', () => {
    it('marks direct PTY as remote-control only', () => {
        expect(new PtyTerminalTransport().capabilities).toEqual(['remote-control']);
    });

    it('marks tmux as local-attach capable', () => {
        expect(new TmuxTerminalTransport('happy-test').capabilities).toEqual(['remote-control', 'local-attach']);
    });
});
```

- [ ] **Step 6: Implement tmux transport**

Create `packages/happy-cli/src/claude/interactive/tmuxTerminalTransport.ts`:

```ts
import { getTmuxUtilities, parseTmuxSessionIdentifier } from '@/utils/tmux';
import type { TerminalExit, TerminalSpawnOptions, TerminalTransport } from './terminalTransport';

export class TmuxTerminalTransport implements TerminalTransport {
    readonly backend = 'tmux' as const;
    readonly capabilities = ['remote-control', 'local-attach'] as const;
    terminalId: string | null = null;
    private tmux;
    private terminalTarget: { session: string; window?: string; pane?: string } | null = null;
    private dataHandlers = new Set<(chunk: string) => void>();
    private exitHandlers = new Set<(exit: TerminalExit) => void>();
    private pollTimer: NodeJS.Timeout | null = null;
    private lastCapture = '';

    constructor(private readonly sessionName: string) {
        this.tmux = getTmuxUtilities(sessionName);
    }

    async spawn(options: TerminalSpawnOptions): Promise<{ pid?: number; terminalId: string }> {
        const commandText = options.shell
            ? options.command
            : [options.command, ...options.args].map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`).join(' ');
        const result = await this.tmux.spawnInTmux(
            [commandText],
            { sessionName: this.sessionName, windowName: options.windowName, cwd: options.cwd },
            options.env,
        );
        if (!result.success || !result.sessionId) {
            throw new Error(result.error ?? 'Failed to spawn Claude in tmux');
        }
        this.terminalId = result.sessionId;
        this.terminalTarget = parseTmuxSessionIdentifier(result.sessionId);
        this.startCapturePolling();
        return { pid: result.pid, terminalId: result.sessionId };
    }

    async paste(text: string): Promise<void> {
        if (!this.terminalTarget) throw new Error('tmux terminal is not spawned');
        const ok = await this.tmux.pasteText(
            text,
            this.terminalTarget.session,
            this.terminalTarget.window,
            this.terminalTarget.pane,
        );
        if (!ok) throw new Error('Failed to paste text into tmux terminal');
    }

    async enter(): Promise<void> {
        if (!this.terminalTarget) throw new Error('tmux terminal is not spawned');
        if (!await this.tmux.sendKeys('C-m', this.terminalTarget.session, this.terminalTarget.window, this.terminalTarget.pane)) {
            throw new Error('Failed to send Enter to tmux terminal');
        }
    }

    async interrupt(): Promise<void> {
        if (!this.terminalTarget) throw new Error('tmux terminal is not spawned');
        if (!await this.tmux.sendKeys('C-c', this.terminalTarget.session, this.terminalTarget.window, this.terminalTarget.pane)) {
            throw new Error('Failed to interrupt tmux terminal');
        }
    }

    async resize(cols: number, rows: number): Promise<void> {
        if (!this.terminalTarget) throw new Error('tmux terminal is not spawned');
        await this.tmux.resizePane(cols, rows, this.terminalTarget.session, this.terminalTarget.window, this.terminalTarget.pane);
    }

    onData(callback: (chunk: string) => void): () => void {
        this.dataHandlers.add(callback);
        return () => this.dataHandlers.delete(callback);
    }

    onExit(callback: (exit: TerminalExit) => void): () => void {
        this.exitHandlers.add(callback);
        return () => this.exitHandlers.delete(callback);
    }

    async dispose(): Promise<void> {
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = null;
        if (this.terminalId) await this.tmux.killWindow(this.terminalId);
        this.terminalId = null;
        this.terminalTarget = null;
        this.dataHandlers.clear();
        this.exitHandlers.clear();
    }

    private startCapturePolling(): void {
        this.pollTimer = setInterval(async () => {
            if (!this.terminalTarget) return;
            const capture = await this.tmux.capturePaneText(
                this.terminalTarget.session,
                this.terminalTarget.window,
                this.terminalTarget.pane,
            );
            if (capture && capture !== this.lastCapture) {
                this.lastCapture = capture;
                for (const handler of this.dataHandlers) handler(capture);
            }
        }, 500);
    }
}
```

- [ ] **Step 7: Implement PTY transport**

Create `packages/happy-cli/src/claude/interactive/ptyTerminalTransport.ts`:

```ts
import type * as Pty from 'node-pty';
import type { TerminalExit, TerminalSpawnOptions, TerminalTransport } from './terminalTransport';

export class PtyTerminalTransport implements TerminalTransport {
    readonly backend = 'pty' as const;
    readonly capabilities = ['remote-control'] as const;
    terminalId: string | null = null;
    private ptyProcess: Pty.IPty | null = null;
    private dataHandlers = new Set<(chunk: string) => void>();
    private exitHandlers = new Set<(exit: TerminalExit) => void>();

    async spawn(options: TerminalSpawnOptions): Promise<{ pid?: number; terminalId: string }> {
        const pty = await import('node-pty');
        const command = options.shell ? (process.env.SHELL || '/bin/sh') : options.command;
        const args = options.shell ? ['-lc', options.command] : options.args;
        const proc = pty.spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            cols: 120,
            rows: 30,
        });
        this.ptyProcess = proc;
        this.terminalId = `pty:${proc.pid}`;
        proc.onData((chunk) => {
            for (const handler of this.dataHandlers) handler(chunk);
        });
        proc.onExit((exit) => {
            for (const handler of this.exitHandlers) handler({ code: exit.exitCode, signal: exit.signal });
        });
        return { pid: proc.pid, terminalId: this.terminalId };
    }

    async paste(text: string): Promise<void> {
        if (!this.ptyProcess) throw new Error('PTY terminal is not spawned');
        this.ptyProcess.write(text);
    }

    async enter(): Promise<void> {
        if (!this.ptyProcess) throw new Error('PTY terminal is not spawned');
        this.ptyProcess.write('\r');
    }

    async interrupt(): Promise<void> {
        if (!this.ptyProcess) throw new Error('PTY terminal is not spawned');
        this.ptyProcess.write('\x03');
    }

    async resize(cols: number, rows: number): Promise<void> {
        this.ptyProcess?.resize(cols, rows);
    }

    onData(callback: (chunk: string) => void): () => void {
        this.dataHandlers.add(callback);
        return () => this.dataHandlers.delete(callback);
    }

    onExit(callback: (exit: TerminalExit) => void): () => void {
        this.exitHandlers.add(callback);
        return () => this.exitHandlers.delete(callback);
    }

    async dispose(): Promise<void> {
        this.ptyProcess?.kill();
        this.ptyProcess = null;
        this.terminalId = null;
        this.dataHandlers.clear();
        this.exitHandlers.clear();
    }
}
```

- [ ] **Step 8: Run tests and typecheck**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit \
  src/utils/tmux.test.ts \
  src/claude/interactive/terminalTransport.test.ts
pnpm --dir packages/happy-cli typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/happy-cli/package.json pnpm-lock.yaml \
  packages/happy-cli/src/utils/tmux.ts \
  packages/happy-cli/src/utils/tmux.test.ts \
  packages/happy-cli/src/claude/interactive/terminalTransport.ts \
  packages/happy-cli/src/claude/interactive/tmuxTerminalTransport.ts \
  packages/happy-cli/src/claude/interactive/ptyTerminalTransport.ts \
  packages/happy-cli/src/claude/interactive/terminalTransport.test.ts
git commit -m "feat: add interactive claude terminal transports"
```

### Task 6: Implement Interactive Claude Remote Launcher

**Files:**
- Create: `packages/happy-cli/src/claude/claudeInteractiveRemoteLauncher.ts`
- Create: `packages/happy-cli/src/claude/claudeInteractiveRemoteLauncher.test.ts`
- Create: `packages/happy-cli/src/claude/interactive/terminalTransportFactory.ts`
- Modify: `packages/happy-cli/src/claude/loop.ts`
- Modify: `packages/happy-cli/src/claude/session.ts`
- Modify: `packages/happy-cli/src/claude/runClaude.ts`

- [ ] **Step 1: Add initial mode to Session**

Modify `packages/happy-cli/src/claude/session.ts`:

```ts
readonly initialMode: EnhancedMode;
```

Add `initialMode: EnhancedMode` to the constructor opts type and assign:

```ts
this.initialMode = opts.initialMode;
```

- [ ] **Step 2: Pass initial mode from runClaude through loop**

In `packages/happy-cli/src/claude/loop.ts`, add `initialMode: EnhancedMode` to `LoopOptions`, then pass it to `new Session({ ... })`.

In `packages/happy-cli/src/claude/runClaude.ts`, before calling `loop`, build:

```ts
const initialEnhancedMode: EnhancedMode = {
    permissionMode: initialPermissionMode,
    model: options.model ?? DEFAULT_CLAUDE_MODEL,
    effort: DEFAULT_CLAUDE_EFFORT,
};
```

Pass `initialMode: initialEnhancedMode` into `loop({ ... })`.

- [ ] **Step 3: Write failing launcher tests**

Create `packages/happy-cli/src/claude/claudeInteractiveRemoteLauncher.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createSessionScanner: vi.fn(),
    resolveInteractiveClaudeIdentity: vi.fn(),
    createTerminalTransport: vi.fn(),
    buildClaudeLocalCommand: vi.fn(),
}));

vi.mock('./utils/sessionScanner', () => ({ createSessionScanner: mocks.createSessionScanner }));
vi.mock('./interactive/sessionIdentity', () => ({ resolveInteractiveClaudeIdentity: mocks.resolveInteractiveClaudeIdentity }));
vi.mock('./interactive/terminalTransportFactory', () => ({ createTerminalTransport: mocks.createTerminalTransport }));
vi.mock('./claudeLocalCommand', () => ({ buildClaudeLocalCommand: mocks.buildClaudeLocalCommand }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));

import { claudeInteractiveRemoteLauncher } from './claudeInteractiveRemoteLauncher';

function createSession(overrides: Partial<any> = {}) {
    return {
        path: '/repo',
        sessionId: null,
        initialMode: { permissionMode: 'default', model: 'opus' },
        claudeArgs: [],
        claudeEnvVars: {},
        mcpServers: {},
        allowedTools: [],
        hookSettingsPath: '/tmp/hook-settings.json',
        queue: {
            waitForMessagesAndGetAsString: vi.fn(async () => null),
            size: vi.fn(() => 0),
            reset: vi.fn(),
            modeHasher: vi.fn(() => 'launch'),
            setOnMessage: vi.fn(),
        },
        client: {
            sendClaudeSessionMessage: vi.fn(),
            sendSessionEvent: vi.fn(),
            closeClaudeSessionTurn: vi.fn(),
            updateMetadata: vi.fn((fn) => fn({})),
            rpcHandlerManager: { registerHandler: vi.fn() },
        },
        onSessionFound: vi.fn(),
        addSessionFoundCallback: vi.fn(),
        removeSessionFoundCallback: vi.fn(),
        onThinkingChange: vi.fn(),
        onAbort: vi.fn(),
        consumeOneTimeFlags: vi.fn(),
        ...overrides,
    };
}

describe('claudeInteractiveRemoteLauncher', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createSessionScanner.mockResolvedValue({ onNewSession: vi.fn(), cleanup: vi.fn(async () => {}) });
        mocks.buildClaudeLocalCommand.mockResolvedValue({
            command: 'node',
            args: ['/repo-root/scripts/claude_local_launcher.cjs', '--session-id', '11111111-1111-4111-8111-111111111111'],
            cwd: '/repo',
            env: {},
            shell: false,
            unwrappedArgs: ['/repo-root/scripts/claude_local_launcher.cjs'],
            cleanupSandbox: null,
        });
        mocks.resolveInteractiveClaudeIdentity.mockReturnValue({
            claudeSessionId: '11111111-1111-4111-8111-111111111111',
            launchArgs: ['--session-id', '11111111-1111-4111-8111-111111111111'],
            consumedArgs: [],
            mode: 'fresh',
        });
    });

    it('starts a terminal with a known Claude session id and does not use SDK', async () => {
        const transport = {
            backend: 'pty',
            terminalId: null,
            capabilities: ['remote-control'],
            spawn: vi.fn(async () => ({ pid: 123, terminalId: 'pty:123' })),
            paste: vi.fn(),
            enter: vi.fn(),
            interrupt: vi.fn(),
            resize: vi.fn(),
            onData: vi.fn(() => vi.fn()),
            onExit: vi.fn(() => vi.fn()),
            dispose: vi.fn(),
        };
        mocks.createTerminalTransport.mockResolvedValue(transport);

        const session = createSession();
        await claudeInteractiveRemoteLauncher(session as any);

        expect(transport.spawn).toHaveBeenCalled();
        expect(mocks.buildClaudeLocalCommand).toHaveBeenCalledWith(expect.objectContaining({
            path: '/repo',
            baseClaudeArgs: ['--session-id', '11111111-1111-4111-8111-111111111111'],
            hookSettingsPath: '/tmp/hook-settings.json',
        }));
        expect(session.onSessionFound).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
        expect(session.client.updateMetadata).toHaveBeenCalled();
    });

    it('rejects attachments before terminal write', async () => {
        const transport = {
            backend: 'pty',
            terminalId: null,
            capabilities: ['remote-control'],
            spawn: vi.fn(async () => ({ pid: 123, terminalId: 'pty:123' })),
            paste: vi.fn(),
            enter: vi.fn(),
            interrupt: vi.fn(),
            resize: vi.fn(),
            onData: vi.fn(() => vi.fn()),
            onExit: vi.fn(() => vi.fn()),
            dispose: vi.fn(),
        };
        mocks.createTerminalTransport.mockResolvedValue(transport);
        const session = createSession({
            queue: {
                waitForMessagesAndGetAsString: vi.fn()
                    .mockResolvedValueOnce({
                        message: 'describe',
                        mode: { permissionMode: 'default', model: 'opus' },
                        hash: 'launch',
                        isolate: false,
                        attachments: [{ data: new Uint8Array([1]), mimeType: 'image/png', name: 'x.png' }],
                    })
                    .mockResolvedValueOnce(null),
                size: vi.fn(() => 0),
                reset: vi.fn(),
                modeHasher: vi.fn(() => 'launch'),
                setOnMessage: vi.fn(),
            },
        });

        await claudeInteractiveRemoteLauncher(session as any);

        expect(transport.paste).not.toHaveBeenCalled();
        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Claude interactive remote does not support image or file attachments yet.',
        });
    });

    it('registers scanner callback and forwards raw JSONL through the existing mapper', async () => {
        const scanner = { onNewSession: vi.fn(), cleanup: vi.fn(async () => {}) };
        mocks.createSessionScanner.mockResolvedValue(scanner);
        const transport = {
            backend: 'pty',
            terminalId: null,
            capabilities: ['remote-control'],
            spawn: vi.fn(async () => ({ pid: 123, terminalId: 'pty:123' })),
            paste: vi.fn(),
            enter: vi.fn(),
            interrupt: vi.fn(),
            resize: vi.fn(),
            onData: vi.fn(() => vi.fn()),
            onExit: vi.fn(() => vi.fn()),
            dispose: vi.fn(),
        };
        mocks.createTerminalTransport.mockResolvedValue(transport);

        const session = createSession();
        await claudeInteractiveRemoteLauncher(session as any);

        expect(session.addSessionFoundCallback).toHaveBeenCalledWith(expect.any(Function));
        const scannerCallback = session.addSessionFoundCallback.mock.calls[0][0];
        scannerCallback('44444444-4444-4444-8444-444444444444');
        expect(scanner.onNewSession).toHaveBeenCalledWith('44444444-4444-4444-8444-444444444444');
        expect(session.removeSessionFoundCallback).toHaveBeenCalledWith(scannerCallback);
    });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit src/claude/claudeInteractiveRemoteLauncher.test.ts
```

Expected: FAIL because launcher and factory files do not exist.

- [ ] **Step 5: Create terminal transport factory**

Create `packages/happy-cli/src/claude/interactive/terminalTransportFactory.ts`:

```ts
import { isTmuxAvailable } from '@/utils/tmux';
import { chooseTerminalBackend, type TerminalTransport } from './terminalTransport';
import { TmuxTerminalTransport } from './tmuxTerminalTransport';
import { PtyTerminalTransport } from './ptyTerminalTransport';

export async function createTerminalTransport(env: NodeJS.ProcessEnv = process.env): Promise<TerminalTransport | null> {
    const tmuxConfigured = env.TMUX_SESSION_NAME !== undefined;
    const tmuxAvailable = await isTmuxAvailable();
    const ptyAvailable = process.platform !== 'win32';
    const backend = chooseTerminalBackend({ tmuxConfigured, tmuxAvailable, ptyAvailable });

    if (backend === 'tmux') return new TmuxTerminalTransport(env.TMUX_SESSION_NAME ?? '');
    if (backend === 'pty') return new PtyTerminalTransport();
    return null;
}
```

- [ ] **Step 6: Implement launcher skeleton**

Create `packages/happy-cli/src/claude/claudeInteractiveRemoteLauncher.ts`:

```ts
import { buildClaudeLocalCommand } from './claudeLocalCommand';
import { resolveInteractiveClaudeIdentity } from './interactive/sessionIdentity';
import { createTerminalTransport } from './interactive/terminalTransportFactory';
import { buildInteractivePaste, validateInteractiveBatch } from './interactive/inputInjection';
import { classifyTerminalOutput } from './interactive/terminalObserver';
import { createSessionScanner } from './utils/sessionScanner';
import { Session } from './session';
import { logger } from '@/ui/logger';

export async function claudeInteractiveRemoteLauncher(session: Session): Promise<'switch' | 'exit'> {
    const identity = resolveInteractiveClaudeIdentity({
        workingDirectory: session.path,
        claudeArgs: session.claudeArgs,
    });
    if (identity.mode === 'unsupported') {
        session.client.updateMetadata((meta) => ({ ...meta, claudeRuntime: { kind: 'interactive', state: 'unsupported', message: identity.error, updatedAt: Date.now() } }));
        session.client.sendSessionEvent({ type: 'message', message: identity.error });
        return 'exit';
    }

    const transport = await createTerminalTransport();
    if (!transport) {
        const message = 'Claude interactive remote is unsupported on this machine because tmux and PTY backends are unavailable.';
        session.client.updateMetadata((meta) => ({ ...meta, claudeRuntime: { kind: 'interactive', state: 'unsupported', message, updatedAt: Date.now() } }));
        session.client.sendSessionEvent({ type: 'message', message });
        return 'exit';
    }

    const built = await buildClaudeLocalCommand({
        path: session.path,
        baseClaudeArgs: identity.launchArgs,
        mcpServers: session.mcpServers,
        allowedTools: session.allowedTools,
        hookSettingsPath: session.hookSettingsPath,
        claudeEnvVars: session.claudeEnvVars,
        sandboxConfig: session.sandboxConfig,
    });

    const scanner = await createSessionScanner({
        sessionId: identity.claudeSessionId,
        workingDirectory: session.path,
        onMessage: (message) => session.client.sendClaudeSessionMessage(message),
    });

    let exitReason: 'switch' | 'exit' | null = null;
    const waitController = new AbortController();
    const scannerSessionCallback = (sessionId: string) => {
        void scanner.onNewSession(sessionId);
    };
    const unsubData = transport.onData((chunk) => {
        const event = classifyTerminalOutput(chunk);
        if (!event) return;
        logger.debug(`[interactive-claude] terminal event ${event.type}: ${event.message}`);
        if (event.type === 'spinner_without_transcript') {
            session.onThinkingChange(true);
        }
        if (event.type === 'input_prompt_visible') {
            session.onThinkingChange(false);
            session.client.closeClaudeSessionTurn('completed');
        }
        if (event.type === 'usage_or_auth_error' || event.type === 'terminal_process_error') {
            session.client.sendSessionEvent({ type: 'message', message: event.message });
        }
    });
    const unsubExit = transport.onExit((exit) => {
        session.client.updateMetadata((meta) => ({
            ...meta,
            claudeRuntime: {
                kind: 'interactive',
                state: exit.code === 0 ? 'degraded' : 'failed',
                backend: transport.backend,
                terminalId: transport.terminalId ?? undefined,
                claudeSessionId: identity.claudeSessionId,
                message: `Claude terminal exited with code ${exit.code ?? 'unknown'}.`,
                updatedAt: Date.now(),
            },
        }));
        exitReason = 'exit';
        waitController.abort();
    });

    session.addSessionFoundCallback(scannerSessionCallback);
    session.onSessionFound(identity.claudeSessionId);
    session.client.updateMetadata((meta) => ({
        ...meta,
        claudeRuntime: {
            kind: 'interactive',
            state: 'starting',
            backend: transport.backend,
            capabilities: transport.capabilities,
            claudeSessionId: identity.claudeSessionId,
            updatedAt: Date.now(),
        },
    }));

    await transport.spawn({
        command: built.command,
        args: built.args,
        cwd: built.cwd,
        env: built.env,
        shell: built.shell,
        windowName: `happy-claude-${Date.now()}`,
    });
    session.consumeOneTimeFlags();

    session.client.updateMetadata((meta) => ({
        ...meta,
        claudeRuntime: {
            kind: 'interactive',
            state: 'interactive',
            backend: transport.backend,
            capabilities: transport.capabilities,
            claudeSessionId: identity.claudeSessionId,
            terminalId: transport.terminalId ?? undefined,
            updatedAt: Date.now(),
        },
    }));

    const launchModeHash = session.queue.modeHasher(session.initialMode);
    session.client.rpcHandlerManager.registerHandler('abort', async () => {
        session.onAbort();
        session.queue.reset();
        session.client.closeClaudeSessionTurn('cancelled');
        await transport.interrupt();
    });
    session.client.rpcHandlerManager.registerHandler('switch', async () => {
        if (transport.backend === 'pty') {
            session.client.sendSessionEvent({
                type: 'message',
                message: 'Switch to local is not supported for direct PTY Claude interactive remote sessions.',
            });
            return;
        }
        exitReason = 'switch';
        waitController.abort();
        await transport.interrupt();
    });

    try {
        while (!exitReason) {
            const batch = await session.queue.waitForMessagesAndGetAsString(waitController.signal);
            if (!batch) break;
            const validation = validateInteractiveBatch({ batch, launchModeHash });
            if (!validation.ok) {
                session.client.sendSessionEvent({ type: 'message', message: validation.message });
                continue;
            }
            const payload = buildInteractivePaste(batch.message, transport.backend);
            await transport.paste(payload);
            if (transport.backend === 'tmux') {
                await transport.enter();
            }
        }
    } finally {
        unsubData();
        unsubExit();
        session.client.rpcHandlerManager.registerHandler('abort', async () => {});
        session.client.rpcHandlerManager.registerHandler('switch', async () => {});
        session.removeSessionFoundCallback(scannerSessionCallback);
        session.onThinkingChange(false);
        await scanner.cleanup();
        await transport.dispose();
        if (built.cleanupSandbox) await built.cleanupSandbox();
    }

    return exitReason ?? 'exit';
}
```

- [ ] **Step 7: Run launcher tests**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit src/claude/claudeInteractiveRemoteLauncher.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run typecheck**

Run:

```bash
pnpm --dir packages/happy-cli typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/happy-cli/src/claude/claudeInteractiveRemoteLauncher.ts \
  packages/happy-cli/src/claude/claudeInteractiveRemoteLauncher.test.ts \
  packages/happy-cli/src/claude/interactive/terminalTransportFactory.ts \
  packages/happy-cli/src/claude/session.ts \
  packages/happy-cli/src/claude/runClaude.ts \
  packages/happy-cli/src/claude/loop.ts
git commit -m "feat: launch claude remote through interactive terminal"
```

### Task 7: Wire Runtime Selection And Daemon Ownership

**Files:**
- Modify: `packages/happy-cli/src/claude/loop.ts`
- Modify: `packages/happy-cli/src/daemon/run.ts`
- Create: `packages/happy-cli/src/daemon/run.interactiveClaude.test.ts`

- [ ] **Step 1: Replace remote launcher selection**

In `packages/happy-cli/src/claude/loop.ts`, change:

```ts
import { claudeRemoteLauncher } from "./claudeRemoteLauncher"
```

to:

```ts
import { claudeInteractiveRemoteLauncher } from "./claudeInteractiveRemoteLauncher"
```

Then change:

```ts
const reason = await claudeRemoteLauncher(session);
```

to:

```ts
const reason = await claudeInteractiveRemoteLauncher(session);
```

- [ ] **Step 2: Keep SDK launcher quarantined**

Do not delete `claudeRemoteLauncher.ts` or `claudeRemote.ts`. Add a short comment at the top of `claudeRemoteLauncher.ts`:

```ts
// Legacy Claude Agent SDK remote launcher. Product Claude remote mode must not
// select this path automatically; see claudeInteractiveRemoteLauncher.ts.
```

- [ ] **Step 3: Extract daemon agent/tmux decision helpers**

Near the top of `packages/happy-cli/src/daemon/run.ts`, after `shellescape`, add:

```ts
type DaemonAgent = 'claude' | 'codex' | 'gemini' | 'openclaw';

export function normalizeDaemonAgent(agent: SpawnSessionOptions['agent'] | undefined): DaemonAgent {
    if (agent === 'codex' || agent === 'gemini' || agent === 'openclaw') return agent;
    return 'claude';
}

export function shouldSpawnHappyControllerInTmux(input: {
    agent: DaemonAgent;
    tmuxAvailable: boolean;
    tmuxSessionName: string | undefined;
}): boolean {
    if (input.agent === 'claude') return false;
    return input.tmuxAvailable && input.tmuxSessionName !== undefined;
}
```

Then in `spawnSession`, compute `agent` before the tmux decision:

```ts
const agent = normalizeDaemonAgent(options.agent);
```

Replace the existing tmux decision block:

```ts
const tmuxAvailable = await isTmuxAvailable();
let useTmux = tmuxAvailable;
let tmuxSessionName: string | undefined = extraEnv.TMUX_SESSION_NAME;
if (!tmuxAvailable || tmuxSessionName === undefined) {
  useTmux = false;
  ...
}
```

with:

```ts
const tmuxAvailable = await isTmuxAvailable();
const tmuxSessionName: string | undefined = extraEnv.TMUX_SESSION_NAME;
let useTmux = shouldSpawnHappyControllerInTmux({ agent, tmuxAvailable, tmuxSessionName });
if (!tmuxAvailable && tmuxSessionName !== undefined) {
  logger.debug(`[DAEMON RUN] tmux session name specified but tmux not available, falling back to regular spawning`);
}
if (agent === 'claude' && tmuxSessionName !== undefined) {
  logger.debug(`[DAEMON RUN] Claude interactive remote keeps Happy controller outside tmux; tmux is reserved for the managed Claude terminal`);
}
```

Inside the tmux branch, remove the duplicate local `agent` declaration and keep using the normalized outer `agent`.

- [ ] **Step 4: Add daemon regression test**

Create `packages/happy-cli/src/daemon/run.interactiveClaude.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeDaemonAgent, shouldSpawnHappyControllerInTmux } from './run';

describe('shouldSpawnHappyControllerInTmux', () => {
    it('normalizes undefined agent to Claude', () => {
        expect(normalizeDaemonAgent(undefined)).toBe('claude');
    });

    it('does not spawn the Happy controller inside tmux for Claude interactive remote', () => {
        expect(shouldSpawnHappyControllerInTmux({
            agent: 'claude',
            tmuxAvailable: true,
            tmuxSessionName: 'happy',
        })).toBe(false);
    });

    it('keeps existing tmux behavior for other agents', () => {
        expect(shouldSpawnHappyControllerInTmux({
            agent: 'codex',
            tmuxAvailable: true,
            tmuxSessionName: 'happy',
        })).toBe(true);
    });
});
```

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit \
  src/claude/claudeInteractiveRemoteLauncher.test.ts \
  src/daemon/run.interactiveClaude.test.ts
pnpm --dir packages/happy-cli typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/happy-cli/src/claude/loop.ts \
  packages/happy-cli/src/claude/claudeRemoteLauncher.ts \
  packages/happy-cli/src/daemon/run.ts \
  packages/happy-cli/src/daemon/run.interactiveClaude.test.ts
git commit -m "feat: route claude remote to interactive runtime"
```

### Task 8: Gate Attachments In The App For Interactive Claude Remote

**Files:**
- Create: `packages/happy-app/sources/sync/attachmentSupport.ts`
- Create: `packages/happy-app/sources/sync/attachmentSupport.test.ts`
- Modify: `packages/happy-app/sources/sync/sync.ts`
- Modify: `packages/happy-app/sources/text/_default.ts`
- Modify: `packages/happy-app/sources/text/translations/en.ts`

- [ ] **Step 1: Write failing attachment support tests**

Create `packages/happy-app/sources/sync/attachmentSupport.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getAttachmentSupportForSession, shouldSendTextAfterDroppingAttachments } from './attachmentSupport';

describe('getAttachmentSupportForSession', () => {
    it('allows normal Claude sessions to send attachments', () => {
        expect(getAttachmentSupportForSession({ metadata: { flavor: 'claude' } })).toEqual({
            supportsAttachments: true,
            unsupportedTextKey: 'imageUpload.notSupportedMessage',
        });
    });

    it('blocks attachments for interactive Claude remote sessions', () => {
        expect(getAttachmentSupportForSession({
            metadata: {
                flavor: 'claude',
                claudeRuntime: { kind: 'interactive', state: 'interactive', updatedAt: 1 },
            },
        })).toEqual({
            supportsAttachments: false,
            unsupportedTextKey: 'imageUpload.interactiveClaudeNotSupportedMessage',
        });
    });

    it('keeps non-Claude attachment behavior disabled', () => {
        expect(getAttachmentSupportForSession({ metadata: { flavor: 'codex' } })).toEqual({
            supportsAttachments: false,
            unsupportedTextKey: 'imageUpload.notSupportedMessage',
        });
    });

    it('does not send an empty text message after unsupported attachment-only sends', () => {
        expect(shouldSendTextAfterDroppingAttachments('')).toBe(false);
        expect(shouldSendTextAfterDroppingAttachments('   \n')).toBe(false);
        expect(shouldSendTextAfterDroppingAttachments('describe this')).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir packages/happy-app test sources/sync/attachmentSupport.test.ts
```

Expected: FAIL because `attachmentSupport.ts` does not exist.

- [ ] **Step 3: Implement attachment support helper**

Create `packages/happy-app/sources/sync/attachmentSupport.ts`:

```ts
type AttachmentSupportSession = {
    metadata?: {
        flavor?: string;
        claudeRuntime?: {
            kind?: string;
        };
    };
};

export type AttachmentUnsupportedTextKey =
    | 'imageUpload.notSupportedMessage'
    | 'imageUpload.interactiveClaudeNotSupportedMessage';

export function getAttachmentSupportForSession(session: AttachmentSupportSession): {
    supportsAttachments: boolean;
    unsupportedTextKey: AttachmentUnsupportedTextKey;
} {
    const flavor = session.metadata?.flavor;
    const isInteractiveClaudeRemote = flavor === 'claude'
        && session.metadata?.claudeRuntime?.kind === 'interactive';

    return {
        supportsAttachments: (!flavor || flavor === 'claude') && !isInteractiveClaudeRemote,
        unsupportedTextKey: isInteractiveClaudeRemote
            ? 'imageUpload.interactiveClaudeNotSupportedMessage'
            : 'imageUpload.notSupportedMessage',
    };
}

export function shouldSendTextAfterDroppingAttachments(text: string): boolean {
    return text.trim().length > 0;
}
```

- [ ] **Step 4: Run helper test**

Run:

```bash
pnpm --dir packages/happy-app test sources/sync/attachmentSupport.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add copy**

In `packages/happy-app/sources/text/_default.ts` under `imageUpload`, add:

```ts
interactiveClaudeNotSupportedMessage: 'Interactive Claude remote does not support image attachments yet. Attachments were not sent.',
```

Add the same key to `packages/happy-app/sources/text/translations/en.ts`.

- [ ] **Step 6: Update support check**

At the top of `packages/happy-app/sources/sync/sync.ts`, add:

```ts
import { getAttachmentSupportForSession, shouldSendTextAfterDroppingAttachments } from './attachmentSupport';
```

In `packages/happy-app/sources/sync/sync.ts`, replace:

```ts
const supportsAttachments = !flavor || flavor === 'claude';
```

with:

```ts
const { supportsAttachments, unsupportedTextKey } = getAttachmentSupportForSession(session);
```

Replace the existing unsupported attachment message passed to `Modal.alert(...)` with:

```ts
const unsupportedMessage = t(unsupportedTextKey);
```

Use `unsupportedMessage` in the existing `Modal.alert(...)`.

Immediately after the unsupported-attachment alert block, add:

```ts
if (attachments && attachments.length > 0 && !supportsAttachments && !shouldSendTextAfterDroppingAttachments(session, text)) {
    return;
}
```

For interactive Claude remote this returns before sending text too, so the app
cannot bypass CLI-side attachment validation by stripping files first. Other
unsupported agents retain the existing text-only fallback when text is present.

- [ ] **Step 7: Run app checks**

Run:

```bash
pnpm --dir packages/happy-app test sources/sync/attachmentSupport.test.ts
pnpm --dir packages/happy-app typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/happy-app/sources/sync/attachmentSupport.ts \
  packages/happy-app/sources/sync/attachmentSupport.test.ts \
  packages/happy-app/sources/sync/sync.ts \
  packages/happy-app/sources/text/_default.ts \
  packages/happy-app/sources/text/translations/en.ts
git commit -m "feat: gate attachments for interactive claude remote"
```

### Task 9: End-To-End CLI Verification And Final Cleanup

**Files:**
- Modify only files revealed by verification failures.

- [ ] **Step 1: Run targeted CLI unit tests**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit \
  src/claude/claudeLocalCommand.test.ts \
  src/claude/interactive/sessionIdentity.test.ts \
  src/claude/interactive/inputInjection.test.ts \
  src/claude/interactive/terminalObserver.test.ts \
  src/claude/interactive/terminalTransport.test.ts \
  src/claude/claudeInteractiveRemoteLauncher.test.ts \
  src/daemon/run.interactiveClaude.test.ts \
  src/utils/tmux.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full CLI unit suite**

Run:

```bash
pnpm --dir packages/happy-cli test
```

Expected: PASS. This command builds first, then runs the unit project.

- [ ] **Step 3: Run app typecheck**

Run:

```bash
pnpm --dir packages/happy-app test sources/sync/attachmentSupport.test.ts
pnpm --dir packages/happy-app typecheck
```

Expected: PASS.

- [ ] **Step 4: Manual tmux smoke**

On a machine with Claude CLI auth and tmux available, run:

```bash
TMUX_SESSION_NAME=happy-test pnpm --dir packages/happy-cli build
TMUX_SESSION_NAME=happy-test node packages/happy-cli/dist/index.mjs claude --happy-starting-mode remote
```

From the app/web session, send:

```text
Say "interactive remote smoke" and then stop.
```

Expected:

- `claudeRuntime.kind` is `interactive`
- `claudeRuntime.backend` is `tmux`
- a real `claude` process is visible in tmux
- no `@anthropic-ai/claude-agent-sdk` query path logs appear
- the response appears through Claude JSONL/session protocol mapping

- [ ] **Step 5: Manual multiline smoke**

Send this prompt from the app:

```text
Create a two-line numbered list:
first
second
```

Expected: Claude receives it as one pasted prompt, not as partially submitted lines.

- [ ] **Step 6: Manual unsupported attachment smoke**

Attach an image in an interactive Claude remote session and send text:

```text
describe this
```

Expected:

- app shows the interactive-remote unsupported attachment message
- no file event is queued for that session
- the text is not sent for interactive Claude remote when an unsupported attachment is present
- image-only sends do not create an empty text prompt

- [ ] **Step 7: Manual direct PTY smoke**

Run without `TMUX_SESSION_NAME` on a Unix-like machine:

```bash
node packages/happy-cli/dist/index.mjs claude --happy-starting-mode remote
```

Expected:

- `claudeRuntime.backend` is `pty`
- app prompts work
- switch-to-local is disabled or returns a clear unsupported message

- [ ] **Step 8: Final hygiene**

Run:

```bash
git diff --check
git status --short
```

Expected:

- `git diff --check` prints no output
- `git status --short` shows only intended source changes before the final commit

- [ ] **Step 9: Commit tracked verification fixes when present**

Run:

```bash
git status --short
```

If the output is empty, skip this step.

If the output contains tracked modified files and no untracked files, run:

```bash
git add -u
git commit -m "fix: stabilize interactive claude remote"
```

If the output contains untracked files, move that file into the owning task above, add its focused test, and rerun the final verification before committing.

## Plan Self-Review Checklist

- Spec coverage:
  - no SDK fallback: Tasks 6 and 7
  - separate Happy controller and Claude terminal ownership: Task 7
  - known Claude session id and deterministic transcript file: Tasks 2 and 6
  - local command parity for MCP, hooks, tools, and sandbox: Task 4
  - paste-safe multiline input: Task 2 and Task 9
  - tmux full capability and PTY remote-only behavior: Tasks 5 and 9
  - safe terminal diagnostics: Task 3
  - unsupported mode/attachment rejection: Tasks 2, 6, and 8
  - app metadata schema: Task 1
- Placeholder scan:
  - searched for forbidden planning markers and unconstrained test instructions; none remain
  - app attachment gating uses a concrete helper and test instead of conditional harness work
- Type consistency:
  - metadata field name is `claudeRuntime`
  - runtime kind is `interactive`
  - backend values are `tmux` and `pty`
  - state values are `starting`, `interactive`, `degraded`, `unsupported`, and `failed`
