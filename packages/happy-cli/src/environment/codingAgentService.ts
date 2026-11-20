import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { realpath, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  CodingAgentIdSchema, CodingAgentsInspectRequestSchema, CodingAgentUpdateRequestSchema,
  type CodingAgentId, type CodingAgentObservation, type CodingAgentsInspectResponse, type CodingAgentUpdateResponse,
} from '@slopus/happy-wire';
import { resolveExecutable, type ProcessRunner } from './processRunner';
import { compareVersions } from './pawsCliAdapter';
import { detectCLIAvailability } from '../utils/detectCLI';
const packages: Record<Exclude<CodingAgentId, 'antigravity'>, string> = {
  codex: '@openai/codex', claude: '@anthropic-ai/claude-code', opencode: 'opencode-ai', gemini: '@google/gemini-cli', openclaw: 'openclaw',
};
type Deps = {
  runner: ProcessRunner; env?: NodeJS.ProcessEnv; home?: string; now?: () => number;
  platform?: NodeJS.Platform;
  availability?: () => Partial<Record<CodingAgentId, boolean>>;
  resolve?: (name: string) => Promise<string | null>;
  realpath?: (path: string) => Promise<string | null>;
  readPackage?: (path: string) => Promise<{ name?: string } | null>;
};
type Probe = { agent: CodingAgentObservation; updater: string | null; args: string[]; identity: string };
type Ticket = { id: CodingAgentId; version: string; path: string; updater: string; args: string[]; target: string; identity: string; expires: number };
const semver = /(?:^|\s|v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|$)/;
export function createCodingAgentService(deps: Deps) {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const resolve = deps.resolve ?? (name => resolveExecutable(name, env.PATH, [join(home, '.local/bin', name), join(home, '.opencode/bin', name)]));
  const real = deps.realpath ?? (path => realpath(path).catch(() => null));
  const readPackage = deps.readPackage ?? (async path => { try { return JSON.parse(await readFile(path, 'utf8')) as { name?: string }; } catch { return null; } });
  const tickets = new Map<string, Ticket>();
  let busy = false;
  const inspections = new Map<CodingAgentId, number>();
  const inspectRun: ProcessRunner['run'] = async (executable, args, options) => {
    try { return await deps.runner.run(executable, args, options); }
    catch { return { exitCode: null, stdout: '', stderr: '', timedOut: false }; }
  };
  const options = { timeoutMs: 15_000, maxOutputBytes: 4096, env };
  async function probe(id: CodingAgentId, check: boolean): Promise<Probe> {
    const executable = await resolve(id === 'antigravity' ? 'agy' : id);
    const agent: CodingAgentObservation = { id, installed: executable !== null, executable, version: null, latestVersion: null, source: 'manual', reason: executable ? 'manual-update' : 'not-installed' };
    if (!executable) return { agent, updater: null, args: [], identity: '' };
    const version = await inspectRun(executable, ['--version'], options);
    if (version.exitCode === 0 && !version.timedOut) agent.version = semver.exec(version.stdout.trim())?.[1] ?? null;
    // Antigravity uses Google's native installer, not an npm package.
    if (id === 'antigravity') {
      agent.reason = agent.version ? 'manual-update' : 'check-failed';
      return { agent, updater: null, args: [], identity: '' };
    }
    const actual = await real(executable);
    const npm = await resolve('npm');
    const packageName = id === 'opencode' && agent.version?.startsWith('2.') ? '@opencode/cli' : packages[id];
    let packageIdentity = '';
    let updater: string | null = null;
    let args: string[] = [];
    if (npm && actual) {
      const root = await inspectRun(npm, ['root', '--global'], options);
      const rootPath = root.stdout.trim();
      if (root.exitCode === 0 && !root.timedOut && isAbsolute(rootPath) && !rootPath.includes('\n')) {
        const packagePath = join(rootPath, packageName);
        const canonicalPackage = await real(packagePath);
        const metadata = await readPackage(join(packagePath, 'package.json'));
        const rel = canonicalPackage ? relative(canonicalPackage, actual) : '..';
        if (canonicalPackage && metadata?.name === packageName && rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) {
          agent.source = 'npm'; updater = npm; args = ['install', '--global']; packageIdentity = canonicalPackage;
        }
      }
    }
    // Only the vendor's native layout opts in to its updater. Custom Codex
    // release links and desktop-bundled CLIs remain manual; never migrate them.
    const claudeNativeRoot = join(home, '.local/share/claude/versions') + sep;
    if (id === 'claude' && actual?.startsWith(claudeNativeRoot)) {
      agent.source = 'native'; updater = executable; args = ['update'];
    }
    if (id === 'opencode' && actual === join(home, '.opencode/bin/opencode')) {
      agent.source = 'native'; updater = executable; args = ['upgrade'];
    }
    const brewInstall = actual?.match(/^(.*)\/(Cellar|Caskroom)\/([^/]+)\//);
    const brewNames: Partial<Record<CodingAgentId, string[]>> = { codex: ['codex'], claude: ['claude-code'], opencode: ['opencode', 'opencode-v2'], gemini: ['gemini-cli'] };
    if (brewInstall && brewNames[id]?.includes(brewInstall[3]!)) {
      const brew = await resolve('brew');
      if (brew) {
        const prefix = await inspectRun(brew, ['--prefix'], options);
        const name = brewInstall[3]!;
        const kind = brewInstall[2] === 'Caskroom' ? '--cask' : '--formula';
        if (prefix.exitCode === 0 && prefix.stdout.trim() === brewInstall[1]) {
          agent.source = 'homebrew'; updater = brew; args = ['upgrade', kind, name];
          packageIdentity = `${brewInstall[1]}/${brewInstall[2]}/${name}`;
          if (check) {
            const info = await inspectRun(brew, ['info', '--json=v2', kind, name], { ...options, maxOutputBytes: 64 * 1024, env: { ...env, HOMEBREW_NO_AUTO_UPDATE: '1' } });
            if (info.exitCode === 0 && !info.timedOut) {
              try {
                const parsed = JSON.parse(info.stdout) as { casks?: Array<{ token?: string; version?: string }>; formulae?: Array<{ name?: string; versions?: { stable?: string } }> };
                const item = kind === '--cask' ? parsed.casks?.find(item => item.token === name) : parsed.formulae?.find(item => item.name === name);
                const value = item && ('version' in item ? item.version : 'versions' in item ? item.versions?.stable : null);
                if (typeof value === 'string' && compareVersions(value, value) !== null) agent.latestVersion = value;
              } catch { /* preserve unknown version */ }
            }
          }
        }
      }
    }
    if (check && npm && agent.source !== 'homebrew') {
      const latest = await inspectRun(npm, ['view', packageName, 'version', '--json'], options);
      if (latest.exitCode === 0 && !latest.timedOut) {
        try { const value: unknown = JSON.parse(latest.stdout); if (typeof value === 'string' && compareVersions(value, value) !== null) agent.latestVersion = value; } catch { /* no actionable version */ }
      }
    }
    if (!agent.version || (check && !agent.latestVersion)) agent.reason = 'check-failed';
    else if (!updater) agent.reason = 'manual-update';
    else if (agent.latestVersion && (compareVersions(agent.version, agent.latestVersion) ?? 0) < 0) agent.reason = 'update-available';
    else agent.reason = 'current';
    if (agent.source === 'npm' && agent.latestVersion) args.push(`${packageName}@${agent.latestVersion}`);
    if (agent.source === 'native' && id === 'opencode' && agent.latestVersion) args.push('--version', agent.latestVersion);
    return { agent, updater, args, identity: JSON.stringify([actual, packageIdentity, updater ? await real(updater) : null]) };
  }
  async function inspect(raw: unknown): Promise<CodingAgentsInspectResponse> {
    const request = CodingAgentsInspectRequestSchema.parse(raw);
    const ids = request.id ? [request.id] : CodingAgentIdSchema.options;
    // Windows npm/Powershell shims cannot be executed by our shell-free runner.
    // Preserve the existing platform detector and require manual management until
    // a verified native/JS-entry adapter exists; never offer a broken updater.
    if ((deps.platform ?? process.platform) === 'win32') {
      tickets.clear();
      const availability = (deps.availability ?? detectCLIAvailability)();
      return { agents: ids.map(id => ({ id, installed: availability[id] === true,
        executable: null, version: null, latestVersion: null, source: 'manual',
        reason: availability[id] === true ? 'manual-update' : 'not-installed' })), checkedAt: now() };
    }
    for (const [key, ticket] of tickets) if (ticket.expires < now()) tickets.delete(key);
    // A row refresh supersedes only that agent's preview, preserving other rows.
    if (request.checkUpdates) {
      for (const id of ids) inspections.set(id, (inspections.get(id) ?? 0) + 1);
      for (const [key, ticket] of tickets) if (ids.includes(ticket.id)) tickets.delete(key);
    }
    const currentInspections = new Map(ids.map(id => [id, inspections.get(id)]));
    const results = await Promise.all(ids.map(async id => {
      try { return await probe(id, request.checkUpdates); }
      catch { return { agent: { id, installed: false, executable: null, version: null, latestVersion: null, source: 'manual', reason: 'check-failed' } as CodingAgentObservation, updater: null, args: [], identity: '' }; }
    }));
    for (const { agent, updater, args, identity } of results) {
      if (currentInspections.get(agent.id) !== inspections.get(agent.id)) continue;
      if (agent.reason === 'update-available' && agent.version && agent.executable && agent.latestVersion && updater) {
        const token = randomUUID();
        tickets.set(token, { id: agent.id, version: agent.version, path: agent.executable, updater, args, target: agent.latestVersion, identity, expires: now() + 600_000 });
        agent.updateToken = token;
      }
    }
    return { agents: results.map(result => result.agent), checkedAt: now() };
  }
  async function update(raw: unknown): Promise<CodingAgentUpdateResponse> {
    const request = CodingAgentUpdateRequestSchema.parse(raw);
    if (busy) return { success: false, reason: 'busy' };
    const ticket = tickets.get(request.updateToken);
    tickets.delete(request.updateToken);
    if (!ticket || ticket.id !== request.id || ticket.expires < now()) return { success: false, reason: 'stale' };
    busy = true;
    try {
      const before = await probe(request.id, false);
      if (before.agent.version !== ticket.version || before.agent.executable !== ticket.path || before.updater !== ticket.updater || before.agent.source === 'manual' || before.identity !== ticket.identity) return { success: false, reason: 'stale' };
      const result = await deps.runner.run(ticket.updater, ticket.args, { ...options, timeoutMs: 8 * 60_000 });
      if (result.exitCode !== 0 || result.timedOut) return { success: false, reason: 'update-failed' };
      const after = await probe(request.id, false);
      const success = after.agent.version !== null && (compareVersions(after.agent.version, ticket.target) ?? -1) >= 0;
      return { success, reason: success ? 'updated' : 'verify-failed', agent: after.agent };
    } catch { return { success: false, reason: 'update-failed' }; }
    finally { busy = false; }
  }
  return { inspect, update };
}
