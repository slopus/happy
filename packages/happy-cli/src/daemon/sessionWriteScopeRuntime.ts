import { execFile } from 'node:child_process';
import { ScopeJournal } from './sessionWriteScopeJournal';
import { join } from 'node:path';
import { createHash, createPublicKey, randomUUID, timingSafeEqual } from 'node:crypto';
import { userInfo } from 'node:os';
import { SandboxConfigSchema } from '@/persistence';
import type { TrackedSession } from './types';
import { SessionWriteScopeBroker } from './sessionWriteScope';
import { canonicalizeSessionWriteRoot } from './sessionWriteScopePaths';
import { replaceSessionWriteScope, scopeSandboxEnvironment } from './sessionWriteScopeRestart';
import { hasReliableResumeBaseline } from './reconnectSessionEnv';
import { configuration } from '@/configuration';
import { readMachineSandboxPolicyMode, sandboxTrustFloorPaths } from '@/sandbox/sandboxPolicy';
import { ScopeReportAuthority } from './sessionWriteScopeReports';
import type { ManagedReportClaim } from './controlServer';
import { StandaloneLaunchControl } from './standaloneLaunchControl';

export function isSessionWriteScopeLaunch(input: { provider: string; userHomeDir?: string; sandboxConfig?: string }): boolean {
  if (!['codex', 'claude'].includes(input.provider) || input.userHomeDir || !input.sandboxConfig) return false;
  try {
    const config = SandboxConfigSchema.parse(JSON.parse(input.sandboxConfig));
    return config.enabled && !config.checkpointProtection;
  } catch { return false; }
}

export async function supportsSessionWriteScopePlatform(platform: NodeJS.Platform, probeLinux = () => new Promise<boolean>(resolve => {
  execFile('/usr/bin/bwrap', ['--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev',
    '--unshare-user', '--unshare-pid', '--unshare-net', '--die-with-parent', '--', '/bin/true'],
    { timeout: 5000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin' } }, error => resolve(!error));
})) {
  if (platform === 'darwin') return true;
  if (platform !== 'linux') return false;
  try { return await probeLinux(); } catch { return false; }
}

export async function createSessionWriteScopeRuntime(input: {
  machineId: string; env: NodeJS.ProcessEnv; managed: boolean;
  findSession: (id: string) => TrackedSession | undefined;
  preserve: (session: TrackedSession) => boolean;
  resume: (id: string, environment: Record<string, string>, validate: () => Promise<void>) => Promise<{ type: string }>;
}) {
  if (input.managed || readMachineSandboxPolicyMode() !== 'owner-choice'
    || input.env.HAPPY_WRITE_SCOPE_HOST_VERSION !== '1') return null;
  if (!await supportsSessionWriteScopePlatform(process.platform)) return null;
  const accountId = input.env.HAPPY_WRITE_SCOPE_HOST_ACCOUNT_ID;
  const incarnation = input.env.HAPPY_WRITE_SCOPE_HOST_INCARNATION;
  const publicPem = input.env.HAPPY_WRITE_SCOPE_HOST_PUBLIC_KEY;
  if (!accountId || !incarnation || !publicPem) return null;
  const publicKey = createPublicKey(publicPem);
  if (publicKey.asymmetricKeyType !== 'ed25519') return null;
  const hostProtected = JSON.parse(input.env.HAPPY_WRITE_SCOPE_HOST_PROTECTED_ROOTS ?? '[]') as unknown;
  if (!Array.isArray(hostProtected) || hostProtected.some(path => typeof path !== 'string')) return null;
  const home = userInfo().homedir;
  const protectedRoots = [...hostProtected as string[], ...sandboxTrustFloorPaths({ homeDir: home, daemonHappyHomeDir: configuration.happyHomeDir })];
  const confirmations = new Map<string, { sessionId: string; digest: string; resolve: (value: boolean) => void }>();
  const reports = new ScopeReportAuthority();
  const applyingSessions = new Set<string>();
  const resolveTarget = (id: string) => {
    const session = input.findSession(id);
    if (!session || session.startedBy !== 'daemon' || !session.childProcess
      || !['codex', 'claude'].includes(session.happySessionMetadataFromLocalWebhook?.flavor ?? '') || !session.encryption
      || session.agentEnvironment?.HAPPY_WRITE_SCOPE_SESSION !== '1'
      || !reports.authenticated(session.pid, id)
      || !hasReliableResumeBaseline({ reportedSeq: session.runtime?.lastProcessedSeq, persistedSeq: session.persistedLastProcessedSeq })
      || !session.directory || !session.agentEnvironment?.HAPPY_PROJECT_SANDBOX_CONFIG) return null;
    const config = SandboxConfigSchema.parse(JSON.parse(session.agentEnvironment.HAPPY_PROJECT_SANDBOX_CONFIG));
    if (!isSessionWriteScopeLaunch({ provider: session.happySessionMetadataFromLocalWebhook!.flavor!, userHomeDir: session.userHomeDir,
      sandboxConfig: session.agentEnvironment.HAPPY_PROJECT_SANDBOX_CONFIG })) return null;
    return { session, config };
  };
  const journal = new ScopeJournal(join(configuration.happyHomeDir, 'session-write-scope.json'), accountId, input.machineId);
  const recovered = await journal.recover();
  const launchControl = await StandaloneLaunchControl.open(incarnation);
  const launches = new Map<number, string>();
  const broker = new SessionWriteScopeBroker({
    changed: requests => journal.write([...recovered, ...requests]),
    accountId, machineId: input.machineId, incarnation, publicKey,
    resolveSession: async id => {
      const target = resolveTarget(id);
      return target ? { projectRoot: target.session.directory!, generation: String(target.session.pid) } : null;
    },
    canonicalize: path => canonicalizeSessionWriteRoot(path, { home, protectedRoots }),
    apply: async (request, roots) => {
      const target = resolveTarget(request.sessionId);
      if (!target || String(target.session.pid) !== request.generation) throw new Error('SESSION_SCOPE_CHANGED');
      const runtime = target.session.runtime;
      // Never interrupt in-flight tool/output work; an agent asks and then parks its turn.
      const busy = !runtime || runtime.thinking || runtime.hasOpenToolCall || runtime.pendingUserInput === true;
      const environment = scopeSandboxEnvironment(target.config, roots, request.projectRoot);
      const token = randomUUID();
      const digest = createHash('sha256').update(environment.HAPPY_PROJECT_SANDBOX_CONFIG).digest('hex');
      const confirmation = new Promise<boolean>(resolve => confirmations.set(token, { sessionId: request.sessionId, digest, resolve }));
      const timer = setTimeout(() => confirmations.get(token)?.resolve(false), 110000);
      applyingSessions.add(request.sessionId);
      try {
        return await replaceSessionWriteScope({ busy, child: target.session.childProcess!,
          preserve: () => input.preserve(target.session),
          drain: async () => {
            const launchId = launches.get(target.session.pid);
            if (!launchId) return false;
            const deadline = performance.now() + 30000;
            const proof = await launchControl.drain(launchId, new AbortController().signal,
              { remainingMs: () => Math.max(0, deadline - performance.now()) });
            return proof.stored && proof.releaseAcknowledged && input.preserve(target.session);
          },
          resume: env => input.resume(request.sessionId, env, async () => {
            for (const root of roots) {
              const checked = await canonicalizeSessionWriteRoot(root.root, { home, protectedRoots });
              if (checked.root !== root.root || checked.identity !== root.identity
                || JSON.stringify(checked.floor) !== JSON.stringify(root.floor)) throw new Error('WRITE_SCOPE_CHANGED');
            }
            if (request.expiresAt <= Date.now()) throw new Error('REQUEST_EXPIRED');
          }), waitForProfile: async () => {
            if (!await confirmation) return false;
            const renewed = resolveTarget(request.sessionId);
            const child = renewed?.session.childProcess;
            return Boolean(renewed && String(renewed.session.pid) !== request.generation
              && child?.exitCode === null && child.signalCode === null);
          },
          environment: { ...environment, HAPPY_WRITE_SCOPE_APPLY_TOKEN: token, HAPPY_WRITE_SCOPE_PROFILE_DIGEST: digest } });
      } finally { clearTimeout(timer); confirmations.delete(token); applyingSessions.delete(request.sessionId); }
    },
  });
  return {
    broker,
    prepareReports: (sessionId?: string) => {
      const launchId = randomUUID(), bootstrap = launchControl.reserve(launchId);
      const report = reports.prepare(sessionId, bootstrap);
      return { environment: report.environment, attach: (child: NonNullable<TrackedSession['childProcess']>) => {
        report.attach(child); launches.set(child.pid!, launchId);
        const forget = () => { launches.delete(child.pid!); launchControl.forget(launchId); };
        child.once('exit', forget); child.once('error', forget);
      } };
    },
    close: () => launchControl.close(),
    verifyReport: (claim: ManagedReportClaim) => reports.verify(claim,
      input.findSession(claim.sessionId)?.agentEnvironment?.HAPPY_WRITE_SCOPE_SESSION === '1'),
    list: (id: string) => [...recovered.filter(request => request.sessionId === id), ...broker.list(id)],
    capabilities: { sessionWriteScope: { version: 1, agents: ['codex', 'claude'], lifetime: 'session', incarnation, accountId,
      machineId: input.machineId, hostKey: createHash('sha256').update(publicPem).digest('hex') } },
    confirm(value: { token: string; sessionId: string; digest: string; pid: number }): boolean {
      const claim = confirmations.get(value.token);
      const session = input.findSession(value.sessionId);
      if (!claim || claim.sessionId !== value.sessionId || session?.pid !== value.pid
        || claim.digest.length !== value.digest.length
        || !timingSafeEqual(Buffer.from(claim.digest), Buffer.from(value.digest))) return false;
      claim.resolve(true); confirmations.delete(value.token); return true;
    },
    isApplying(id: string) { return applyingSessions.has(id); },
    sessionEnded(id: string) { if (!applyingSessions.has(id)) broker.sessionEnded(id); },
  };
}
export type SessionWriteScopeRuntime = NonNullable<Awaited<ReturnType<typeof createSessionWriteScopeRuntime>>>;
