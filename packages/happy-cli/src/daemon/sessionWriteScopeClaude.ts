import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { SandboxConfigSchema, type SandboxConfig } from '@/persistence';
import { initializeSandbox, wrapCommand } from '@/sandbox/manager';
import { verifySandboxExecutionCapability } from '@/sandbox/executionCapability';
import { query } from '@/claude/sdk/query';
import type { QueryOptions } from '@/claude/sdk/types';
import { confirmSessionWriteScope, type ScopeConfirmation } from './sessionWriteScopeConfirmation';

export type ScopeClaudeSandbox = { spawn: (options: SpawnOptions) => ChildProcess; close: () => Promise<void> };

/** A single immutable OS boundary for every SDK generation of an owned Claude session. */
export async function prepareSessionWriteScopeClaude(input: {
  path: string; config: SandboxConfig | undefined; confirmation: ScopeConfirmation | null; platform?: NodeJS.Platform;
}): Promise<ScopeClaudeSandbox> {
  if (!['darwin', 'linux'].includes(input.platform ?? process.platform) || !input.config?.enabled || input.config.checkpointProtection) {
    throw new Error('SCOPE_CLAUDE_UNSUPPORTED');
  }
  const path = realpathSync(input.path);
  const config = SandboxConfigSchema.parse(JSON.parse(JSON.stringify(input.config)));
  // Linux skips nonexistent writable roots; initialize only the provider's state root.
  const claudeState = (process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')).replace(/^~(?=\/|$)/, homedir());
  await mkdir(resolve(path, claudeState), { recursive: true, mode: 0o700 });
  const reset = await initializeSandbox(config, path, 'mandatory');
  const children = new Set<ChildProcess>();
  let closed = false;
  const close = async () => {
    if ([...children].some(child => child.exitCode === null && child.signalCode === null)) throw new Error('SCOPE_CLAUDE_EXIT_UNCONFIRMED');
    if (!closed) { closed = true; await reset(); }
  };
  try {
    const capability = await verifySandboxExecutionCapability();
    if (!capability.ok) throw new Error('SCOPE_CLAUDE_SANDBOX_UNAVAILABLE');
    // Arguments are shell-quoted once at spawn, inside this already prepared boundary.
    // The command carrier is removed by the inner shell before exec reaches Claude.
    const wrapped = await wrapCommand('exec /bin/sh -c "$HAPPY_SCOPE_CLAUDE_COMMAND"');
    const launch: ScopeClaudeSandbox['spawn'] = options => {
      if (closed || options.signal.aborted || realpathSync(options.cwd ?? path) !== path
        || [options.command, ...options.args].some(arg => arg.includes('\0'))) throw new Error('SCOPE_CLAUDE_SPAWN_REJECTED');
      const env = { ...options.env };
      for (const key of Object.keys(env)) if (key.startsWith('HAPPY_WRITE_SCOPE_') || key === 'HAPPY_SCOPE_REPORT_FD') delete env[key];
      const child = spawn('/bin/sh', ['-c', wrapped], { cwd: path, env: { ...env,
        HAPPY_SCOPE_CLAUDE_COMMAND: 'unset HAPPY_SCOPE_CLAUDE_COMMAND; exec ' + [options.command, ...options.args].map(arg => "'" + arg.replace(/'/g, "'\"'\"'") + "'").join(' '),
      }, signal: options.signal, detached: true, stdio: ['pipe', 'pipe', 'inherit'] });
      children.add(child);
      child.once('exit', () => children.delete(child));
      child.once('error', () => { if (!child.pid) children.delete(child); });
      return child;
    };
    let probe: ChildProcess | undefined;
    let exit: Promise<boolean> | undefined;
    const controller = new AbortController();
    // Control initialization needs no user message and never performs a model turn.
    const client = query({ prompt: { async *[Symbol.asyncIterator]() {
      await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
    } }, options: { cwd: path, tools: [], settingSources: [], strictMcpConfig: true, mcpServers: {}, sandbox: { enabled: false },
      spawnClaudeCodeProcess: options => {
        probe = launch(options);
        exit = new Promise<boolean>(resolve => { probe!.once('exit', (code, signal) => resolve(code === 0 && signal === null)); probe!.once('error', () => resolve(false)); });
        return probe as ReturnType<NonNullable<QueryOptions['spawnClaudeCodeProcess']>>;
      } } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([client.supportedCommands(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('SCOPE_CLAUDE_INITIALIZATION_TIMEOUT')), 15000);
      })]);
    } finally { clearTimeout(timer); client.close(); controller.abort(); }
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!exit || !await Promise.race([exit, new Promise<boolean>(resolve => { exitTimer = setTimeout(() => resolve(false), 5000); })])) {
        throw new Error('SCOPE_CLAUDE_EXIT_UNCONFIRMED');
      }
    } finally { clearTimeout(exitTimer); }
    await confirmSessionWriteScope(input.confirmation, true, config);
    return { spawn: launch, close };
  } catch (error) {
    await close();
    throw error;
  }
}
