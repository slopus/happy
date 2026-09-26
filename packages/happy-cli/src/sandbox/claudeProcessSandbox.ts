/** Mandatory browser sessions cross a UID boundary through the installed fixed launcher. */
import { spawn, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { SandboxConfig } from '@/persistence';
import { configuration } from '@/configuration';
import { MandatorySandboxError } from './sandboxPolicy';
import { checkSandboxPrerequisites, checkProxyReachable, SANDBOX_LAUNCHER } from './sandboxPreflight';

const CLAUDE_ENV = new Set(['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_ENTRYPOINT', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'MAX_THINKING_TOKENS', 'SAYCODE_MCP_SOCKET', 'SAYCODE_MCP_TOKEN']);
export function filterClaudeProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...Object.fromEntries(Object.entries(env).filter(([key, value]) => CLAUDE_ENV.has(key) && value !== undefined)),
        PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/agent-sbx', USER: 'agent-sbx', CLAUDE_CONFIG_DIR: '/home/agent-sbx/.claude', TMPDIR: '/tmp',
        HTTPS_PROXY: 'http://127.0.0.1:3128', HTTP_PROXY: 'http://127.0.0.1:3128', https_proxy: 'http://127.0.0.1:3128', http_proxy: 'http://127.0.0.1:3128',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
}
export function encodeLauncherInput(options: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }, denyRead: string[] = [], denyWrite: string[] = [], networkBlocked = false): Buffer {
    const argv = [options.command, ...options.args];
    if (!options.command.startsWith('/') || argv.some(arg => arg.includes('\0')) || argv.length > 65536) throw new MandatorySandboxError('init-failed', 'invalid launcher argv');
    const meta = { version: 1, argc: argv.length, cwd: options.cwd, env: filterClaudeProcessEnv(options.env), denyRead, denyWrite, networkBlocked };
    const buffer = Buffer.from([JSON.stringify(meta), ...argv, ''].join('\0'));
    if (buffer.length > 4 * 1024 * 1024) throw new MandatorySandboxError('init-failed', 'launcher argv too large');
    return buffer;
}
export type ClaudeProcessSandbox = { claudeConfigDir: string; spawn: (options: SpawnOptions) => ChildProcess; close: () => Promise<void> };
export async function prepareClaudeProcessSandbox(input: {
    sandboxConfig: SandboxConfig | undefined; sessionPath: string; mcpSocketPath?: string;
    additionalDenyRead?: string[]; additionalDenyWrite?: string[];
}): Promise<ClaudeProcessSandbox> {
    if (!input.sandboxConfig) throw new MandatorySandboxError('missing-config');
    if (!input.sandboxConfig.enabled) throw new MandatorySandboxError('disabled-config');
    if (input.sandboxConfig.networkMode === 'custom' || input.sandboxConfig.deniedDomains.length) throw new MandatorySandboxError('capability-unavailable', 'session domain restrictions require an installation proxy policy');
    if (process.platform !== 'linux') throw new MandatorySandboxError('capability-unavailable');
    const cwd = realpathSync(input.sessionPath);
    if (cwd !== '/work' && !cwd.startsWith('/work/')) throw new MandatorySandboxError('unsafe-write-scope', 'mandatory workspace must be under /work');
    checkSandboxPrerequisites(input.mcpSocketPath, configuration.happyHomeDir);
    await checkProxyReachable();
    const read = [...new Set([configuration.happyHomeDir, ...input.sandboxConfig.denyReadPaths, ...(input.additionalDenyRead ?? [])].map(p => resolve(cwd, p)))];
    const write = [...new Set([...input.sandboxConfig.denyWritePaths, ...(input.additionalDenyWrite ?? [])].map(p => resolve(cwd, p)))];
    const children = new Set<ChildProcess>();
    let closed = false;
    const launch = (options: SpawnOptions): ChildProcess => {
        if (closed || options.signal.aborted || realpathSync(options.cwd ?? cwd) !== cwd) throw new MandatorySandboxError('init-failed', 'spawn cancelled or workspace changed');
        checkSandboxPrerequisites(input.mcpSocketPath, configuration.happyHomeDir);
        const frame = encodeLauncherInput({ ...options, cwd }, read, write, input.sandboxConfig!.networkMode === 'blocked');
        const child = spawn('/usr/bin/sudo', ['-n', '-u', 'agent-sbx', SANDBOX_LAUNCHER, '0'], {
            cwd, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'inherit'],
        });
        // stdin is the sole argv descriptor; the launcher consumes the prefix before SDK input.
        child.stdin!.on('error', () => {});
        child.stdin!.write(frame);
        const cancel = () => { child.kill('SIGTERM'); };
        options.signal.addEventListener('abort', cancel, { once: true });
        children.add(child);
        const cleanup = () => { children.delete(child); options.signal.removeEventListener('abort', cancel); };
        child.once('exit', cleanup); child.once('error', cleanup);
        return child;
    };
    const probe = launch({ command: '/bin/true', args: [], cwd, env: {}, signal: new AbortController().signal });
    probe.stdin!.end();
    await new Promise<void>((resolveProbe, reject) => {
        const timer = setTimeout(() => { probe.kill('SIGTERM'); reject(new MandatorySandboxError('init-failed', 'launcher preflight timed out')); }, 10000);
        probe.once('error', () => { clearTimeout(timer); reject(new MandatorySandboxError('init-failed')); });
        probe.once('exit', code => { clearTimeout(timer); if (code === 0) resolveProbe(); else reject(new MandatorySandboxError('init-failed', 'launcher preflight failed')); });
    });
    return {
        claudeConfigDir: '/home/agent-sbx/.claude', spawn: launch,
        async close() {
            closed = true;
            await Promise.all([...children].map(child => new Promise<void>(resolveExit => {
                child.once('exit', () => resolveExit());
                child.kill('SIGTERM');
            })));
        },
    };
}
