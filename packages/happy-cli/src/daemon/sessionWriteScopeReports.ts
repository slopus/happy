import { randomBytes, randomUUID } from 'node:crypto';
import { close, read } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { ManagedReportClaim } from './controlServer';
import { mintManagedReportCapability, readCapabilityLaunchId, verifyManagedReportCapability } from './launch/managedReportCapability';
import { launchBootstrapSchema, type StandaloneLaunchBootstrap } from './standaloneLaunchProtocol';

export const SCOPE_REPORT_FD = 'HAPPY_SCOPE_REPORT_FD';
export const SCOPE_REPORT_HEADER = 'x-happy-scope-report';
const MAX_BYTES = 4096;
type Launch = { secret: Buffer; pid: number; sessionId?: string; seq: number; authenticated: boolean };

/** Local owned launches only. Report authority is distinct from human approval authority. */
export class ScopeReportAuthority {
  private readonly launches = new Map<string, Launch>();
  prepare(sessionId?: string, bootstrap?: StandaloneLaunchBootstrap) {
    const id = randomUUID(), secret = randomBytes(32);
    return {
      environment: { [SCOPE_REPORT_FD]: '3' },
      attach: (child: ChildProcess) => {
        if (!child.pid) throw new Error('SCOPE_REPORT_NO_PID');
        this.launches.set(id, { secret, pid: child.pid, sessionId, seq: 0, authenticated: false });
        const pipe = child.stdio[3] as Writable;
        pipe.on('error', () => { this.launches.delete(id); });
        child.once('exit', () => { this.launches.delete(id); });
        child.once('error', () => { this.launches.delete(id); });
        pipe.end(JSON.stringify({ id, secret: secret.toString('base64'), bootstrap }));
      },
    };
  }
  authenticated(pid: number, sessionId: string) {
    return [...this.launches.values()].some(launch => launch.pid === pid && launch.sessionId === sessionId && launch.authenticated);
  }
  verify(claim: ManagedReportClaim, protectedSession: boolean): boolean {
    const pid = claim.kind === 'session-started'
      ? (claim.report.metadata as { hostPid?: unknown } | null)?.hostPid : claim.report.hostPid;
    const protectedPid = [...this.launches.values()].some(launch => launch.pid === pid);
    const capability = claim.headers[SCOPE_REPORT_HEADER];
    if (!protectedSession && !protectedPid && capability === undefined) return true;
    if (typeof capability !== 'string') return false;
    const id = readCapabilityLaunchId(capability), launch = id ? this.launches.get(id) : undefined;
    if (!launch || launch.pid !== pid || (launch.sessionId && launch.sessionId !== claim.sessionId)) return false;
    // Only the initial webhook may establish a new launch's session identity.
    if (!launch.sessionId && claim.kind !== 'session-started') return false;
    const checked = verifyManagedReportCapability({ capability, secret: launch.secret, kind: claim.kind, body: claim.report, now: Date.now() });
    if (!checked.ok || checked.claims.seq <= launch.seq) return false;
    launch.seq = checked.claims.seq; launch.sessionId = claim.sessionId; launch.authenticated = true;
    return true;
  }
}

let signer: Promise<((kind: ManagedReportClaim['kind'], body: unknown) => string) | null> | undefined;
let scopeBootstrap: StandaloneLaunchBootstrap | undefined;
export function takeScopeLaunchBootstrap() { const bootstrap = scopeBootstrap; scopeBootstrap = undefined; return bootstrap; }
/** Consume and close the inherited pipe before creating any agent transport or provider child. */
export function initializeScopeReportSigner() {
  signer ??= (async () => {
    const raw = process.env[SCOPE_REPORT_FD]; delete process.env[SCOPE_REPORT_FD];
    if (raw === undefined) {
      if (process.env.HAPPY_WRITE_SCOPE_SESSION === '1') throw new Error('SCOPE_REPORT_CREDENTIAL_REQUIRED');
      return null;
    }
    if (raw !== '3') throw new Error('SCOPE_REPORT_INVALID_FD');
    const chunks: Buffer[] = []; let size = 0;
    try {
      while (true) {
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const count = await new Promise<number>((resolve, reject) => read(3, buffer, 0, buffer.length, null, (error, count) => error ? reject(error) : resolve(count)));
        if (!count) break;
        size += count; if (size > MAX_BYTES) throw new Error('SCOPE_REPORT_OVERSIZED');
        chunks.push(buffer.subarray(0, count));
      }
    } finally { await new Promise<void>(resolve => close(3, () => resolve())); }
    const credential = JSON.parse(Buffer.concat(chunks).toString());
    if (credential.bootstrap) scopeBootstrap = launchBootstrapSchema.parse(credential.bootstrap);
    if (process.env.HAPPY_WRITE_SCOPE_SESSION === '1' && !scopeBootstrap) throw new Error('SCOPE_DRAIN_CREDENTIAL_REQUIRED');
    if (typeof credential.id !== 'string' || typeof credential.secret !== 'string') throw new Error('SCOPE_REPORT_INVALID_CREDENTIAL');
    const secret = Buffer.from(credential.secret, 'base64'); let seq = 0;
    if (secret.length !== 32) throw new Error('SCOPE_REPORT_INVALID_CREDENTIAL');
    return (kind: ManagedReportClaim['kind'], body: unknown) => mintManagedReportCapability({
      secret, launchId: credential.id, kind, body, seq: ++seq, expiresAt: Date.now() + 60000,
    });
  })();
  return signer;
}
