import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ScopeReportAuthority, SCOPE_REPORT_HEADER } from './sessionWriteScopeReports';
import { mintManagedReportCapability } from './launch/managedReportCapability';
import type { ManagedReportClaim } from './controlServer';

describe('owned scope lifecycle reports', () => {
  it('requires a launch signature and binds the entire report to pid, session and sequence', async () => {
    const authority = new ScopeReportAuthority();
    const launch = authority.prepare('session');
    const child = spawn(process.execPath, ['-e', "require('fs').readFile(3,'utf8',(_,v)=>{process.stdout.write(v+'\\n')});setInterval(()=>{},1000)"],
      { env: { ...process.env, ...launch.environment }, stdio: ['ignore', 'pipe', 'ignore', 'pipe'] });
    launch.attach(child);
    try {
      const [bytes] = await once(child.stdout!, 'data');
      const credential = JSON.parse(bytes.toString());
      const body = { sessionId: 'session', metadata: { hostPid: child.pid, flavor: 'codex' }, encryption: {
        encryptionKey: 'fixture', encryptionVariant: 'legacy' as const, seq: 1, metadataVersion: 1, agentStateVersion: 1,
      } };
      const signed = (report: typeof body, seq: number): ManagedReportClaim => ({ kind: 'session-started', sessionId: report.sessionId, report,
        headers: { [SCOPE_REPORT_HEADER]: mintManagedReportCapability({ launchId: credential.id, secret: Buffer.from(credential.secret, 'base64'),
          kind: 'session-started', seq, expiresAt: Date.now() + 10000, body: report }) } });
      expect(authority.verify({ ...signed(body, 1), headers: {} }, true)).toBe(false);
      expect(authority.authenticated(child.pid!, 'session')).toBe(false);
      expect(authority.verify(signed({ ...body, sessionId: 'other' }, 1), true)).toBe(false);
      expect(authority.verify(signed({ ...body, metadata: { ...body.metadata, hostPid: child.pid! + 1 } }, 1), true)).toBe(false);
      expect(authority.verify({ ...signed(body, 1), report: { ...body, encryption: { ...body.encryption, seq: 999 } } }, true)).toBe(false);
      expect(authority.verify(signed(body, 1), true)).toBe(true);
      expect(authority.verify(signed(body, 1), true)).toBe(false);
      expect(authority.authenticated(child.pid!, 'session')).toBe(true);
      expect(authority.verify({ kind: 'session-runtime', sessionId: 'session', headers: {}, report: { sessionId: 'session', hostPid: child.pid, thinking: false } }, true)).toBe(false);
      child.kill(); await once(child, 'exit');
      expect(authority.verify(signed(body, 2), true)).toBe(false);
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } }
  });
  it('does not change legacy report admission but refuses restored protected sessions', () => {
    const authority = new ScopeReportAuthority();
    const claim: ManagedReportClaim = { kind: 'session-runtime', sessionId: 'legacy', headers: {}, report: { hostPid: 42 } };
    expect(authority.verify(claim, false)).toBe(true);
    expect(authority.verify(claim, true)).toBe(false);
  });
});
