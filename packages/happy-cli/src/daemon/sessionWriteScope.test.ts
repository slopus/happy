import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SessionWriteScopeBroker, decisionBytes, type ScopeDecision, type ScopeRequest } from './sessionWriteScope';

function fixture() {
  const keys = generateKeyPairSync('ed25519');
  let now = 1000;
  const apply = vi.fn(async () => ({ profileApplied: true, cleanup: 'unresolved' as const }));
  const canonicalize = vi.fn(async (path: string) => ({ requestedPath: path, root: path, identity: 'dev:ino', floor: ['/protected'] }));
  const changed = vi.fn(async (_requests: ScopeRequest[]) => {});
  const broker = new SessionWriteScopeBroker({
    publicKey: keys.publicKey, machineId: 'machine', accountId: 'account', incarnation: 'launch',
    now: () => now, resolveSession: async (sessionId) => sessionId === 'session'
      ? { projectRoot: '/project', generation: 'pid-1' } : null,
    canonicalize, apply, changed,
  });
  const decide = (request: ScopeRequest, action: ScopeDecision['action'] = 'allow', privateKey = keys.privateKey) => {
    const decision: ScopeDecision = { version: 1, requestId: request.id, digest: request.digest, incarnation: 'launch',
      accountId: 'account', machineId: 'machine', sessionId: 'session', action };
    return { decision, signature: sign(null, decisionBytes(decision), privateKey).toString('base64url') };
  };
  return { broker, apply, decide, canonicalize, changed, advance: () => { now += 600001; } };
}

describe('session write scope approval authority', () => {
  it('refuses an agent signature and never treats a shared bearer as approval', async () => {
    const f = fixture();
    const request = await f.broker.request('session', '/target', 'Install tool');
    await expect(f.broker.decide(f.decide(request, 'allow', generateKeyPairSync('ed25519').privateKey))).rejects.toThrow('INVALID_APPROVAL');
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.broker.list('session')[0].state).toBe('pending');
  });
  it('consumes approval before awaiting apply and reports unresolved cleanup honestly', async () => {
    const f = fixture();
    const request = await f.broker.request('session', '/target', 'Install tool');
    const envelope = f.decide(request);
    const result = f.broker.decide(envelope);
    await expect(f.broker.decide(envelope)).rejects.toThrow('REQUEST_NOT_PENDING');
    expect((await result).state).toBe('cleanup-unresolved');
    expect(f.apply).toHaveBeenCalledTimes(1);
  });
  it('rejects expired, cancelled and foreign bound requests', async () => {
    const f = fixture();
    const request = await f.broker.request('session', '/target', 'Install tool');
    const foreign = f.decide(request); foreign.decision.sessionId = 'other';
    await expect(f.broker.decide(foreign)).rejects.toThrow();
    f.advance();
    await expect(f.broker.decide(f.decide(request))).rejects.toThrow('REQUEST_NOT_PENDING');
    expect(f.broker.list('session')[0].state).toBe('expired');
    expect(f.apply).not.toHaveBeenCalled();
  });
  it('project alternative/cancel creates no grant and replay cannot reapply', async () => {
    for (const action of ['project', 'cancel'] as const) {
      const f = fixture();
      const request = await f.broker.request('session', '/target', 'Install tool');
      expect((await f.broker.decide(f.decide(request, action))).state).toBe(action === 'project' ? 'project-local' : 'cancelled');
      await expect(f.broker.decide(f.decide(request))).rejects.toThrow('REQUEST_NOT_PENDING');
      expect(f.apply).not.toHaveBeenCalled();
    }
  });
  it('records partial failure without automatic reapplication', async () => {
    const f = fixture(); f.apply.mockRejectedValueOnce(new Error('raw secret must not be copied'));
    const request = await f.broker.request('session', '/target', 'Install tool');
    const result = await f.broker.decide(f.decide(request));
    expect(result.state).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('raw secret');
    await expect(f.broker.decide(f.decide(request))).rejects.toThrow('REQUEST_NOT_PENDING');
  });
  it('does not expose mutable descriptors or restore approvals after restart', async () => {
    const f = fixture(); const request = await f.broker.request('session', '/target', 'Install tool');
    request.root = '/changed'; f.broker.list('session')[0].root = '/changed';
    expect(f.broker.list('session')[0].root).toBe('/target');
    await expect(fixture().broker.decide(f.decide(request))).rejects.toThrow();
  });
  it('rejects freeform credential-bearing descriptions', async () => {
    const f = fixture();
    await expect(f.broker.request('session', '/target', 'TOKEN=private-value')).rejects.toThrow('SECRET_FREE_DESCRIPTION_REQUIRED');
  });
  it('does not apply if persisting the consumption intent fails', async () => {
    const f = fixture(); const request = await f.broker.request('session', '/target', 'Install tool');
    f.changed.mockRejectedValueOnce(new Error('journal failed'));
    expect((await f.broker.decide(f.decide(request))).state).toBe('failed');
    expect(f.apply).not.toHaveBeenCalled();
    await expect(f.broker.decide(f.decide(request))).rejects.toThrow('REQUEST_NOT_PENDING');
  });
  it('rechecks expiry after revalidating previous roots', async () => {
    const f = fixture(); const first = await f.broker.request('session', '/one', 'Install tool');
    await f.broker.decide(f.decide(first));
    const second = await f.broker.request('session', '/two', 'Install tool');
    f.canonicalize.mockImplementation(async path => {
      if (path === '/one') f.advance();
      return { requestedPath: path, root: path, identity: 'dev:ino', floor: ['/protected'] };
    });
    expect((await f.broker.decide(f.decide(second))).state).toBe('failed');
    expect(f.apply).toHaveBeenCalledTimes(1);
  });
  it('enforces the active root limit when approving requests prepared before any grant', async () => {
    const f = fixture();
    const requests = await Promise.all(Array.from({ length: 9 }, (_, index) =>
      f.broker.request('session', `/target-${index}`, 'Install tool')));
    for (const request of requests.slice(0, 8)) await f.broker.decide(f.decide(request));
    expect((await f.broker.decide(f.decide(requests[8]))).state).toBe('failed');
    expect(f.apply).toHaveBeenCalledTimes(8);
    expect(f.broker.list('session').filter(request => request.grantActive)).toHaveLength(8);
    const revoke = await f.broker.request('session', requests[0].root, 'Revoke tool', 'revoke');
    await f.broker.decide(f.decide(revoke));
    const retry = await f.broker.request('session', requests[8].root, 'Install tool');
    expect((await f.broker.decide(f.decide(retry))).profileApplied).toBe(true);
  });
  it('does not mark cancelled or project-local requests active when the same root is later granted', async () => {
    for (const action of ['cancel', 'project'] as const) {
      const f = fixture();
      const abandoned = await f.broker.request('session', '/target', 'Install tool');
      await f.broker.decide(f.decide(abandoned, action));
      const granted = await f.broker.request('session', '/target', 'Install tool');
      await f.broker.decide(f.decide(granted));
      expect(f.broker.list('session').filter(request => request.grantActive).map(request => request.id)).toEqual([granted.id]);
    }
  });
  it.each(['missing', 'replaced'])('revokes an existing grant after its directory is %s', async state => {
    const f = fixture();
    const grant = await f.broker.request('session', '/target', 'Install tool');
    await f.broker.decide(f.decide(grant));
    f.canonicalize.mockImplementation(async path => {
      if (state === 'missing') throw new Error('ENOENT');
      return { requestedPath: path, root: path, identity: 'replacement-inode', floor: ['/protected'] };
    });
    const revoke = await f.broker.request('session', '/target', 'Revoke tool', 'revoke');
    expect((await f.broker.decide(f.decide(revoke))).profileApplied).toBe(true);
    expect(f.apply).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'revoke' }), []);
    expect(f.broker.list('session').find(request => request.id === grant.id)?.grantActive).toBe(false);
    expect(f.broker.list('session').find(request => request.id === revoke.id)?.state).toBe('cleanup-unresolved');
  });
  it('does not reuse a revoked root when another remaining grant fails revalidation', async () => {
    const f = fixture();
    for (const path of ['/target', '/other']) {
      const request = await f.broker.request('session', path, 'Install tool');
      await f.broker.decide(f.decide(request));
    }
    const revoke = await f.broker.request('session', '/target', 'Revoke tool', 'revoke');
    f.canonicalize.mockImplementation(async path => ({ requestedPath: path, root: path,
      identity: path === '/other' ? 'replacement-inode' : 'dev:ino', floor: ['/protected'] }));
    expect((await f.broker.decide(f.decide(revoke))).state).toBe('failed');
    expect(f.apply).toHaveBeenCalledTimes(2);
    expect(f.broker.list('session').filter(request => request.grantActive).map(request => request.root)).toEqual(['/other']);
  });
  it('does not let an old revocation remove a subsequently replaced grant record', async () => {
    const f = fixture();
    const first = await f.broker.request('session', '/target', 'Install tool');
    await f.broker.decide(f.decide(first));
    const oldRevoke = await f.broker.request('session', '/target', 'Revoke tool', 'revoke');
    const replacement = await f.broker.request('session', '/target', 'Install tool');
    await f.broker.decide(f.decide(replacement));
    expect((await f.broker.decide(f.decide(oldRevoke))).state).toBe('failed');
    expect(f.apply).toHaveBeenCalledTimes(2);
    expect(f.broker.list('session').find(request => request.id === replacement.id)?.grantActive).toBe(true);
  });
  it('admits new work after more than 128 cancelled requests while retaining the live limit', async () => {
    const f = fixture();
    for (let i = 0; i < 140; i++) {
      const request = await f.broker.request('session', '/target', 'Install tool');
      await f.broker.cancel('session', request.id);
    }
    const pending = await Promise.all(Array.from({ length: 128 }, (_, i) =>
      f.broker.request('session', `/pending-${i}`, 'Install tool')));
    expect(pending).toHaveLength(128);
    await expect(f.broker.request('session', '/overflow', 'Install tool')).rejects.toThrow('REQUEST_LIMIT_REACHED');
    await f.broker.cancel('session', pending[0].id);
    expect((await f.broker.request('session', '/replacement', 'Install tool')).state).toBe('pending');
  });
  it('does not publish or approve a request until its creation has been persisted', async () => {
    const f = fixture();
    let rejectWrite!: (error: Error) => void;
    let staged!: ScopeRequest;
    const writeStarted = new Promise<void>(resolve => {
      f.changed.mockImplementationOnce(requests => {
        staged = requests.at(-1)!; resolve();
        return new Promise<void>((_, reject) => { rejectWrite = reject; });
      });
    });
    const requested = f.broker.request('session', '/target', 'Install tool');
    const failed = expect(requested).rejects.toThrow('journal failed');
    await writeStarted;
    expect(f.broker.list('session')).toEqual([]);
    await expect(f.broker.decide(f.decide(staged))).rejects.toThrow('REQUEST_NOT_PENDING');
    rejectWrite(new Error('journal failed')); await failed;
    expect(f.broker.list('session')).toEqual([]);
    expect((await f.broker.request('session', '/target', 'Install tool')).id).not.toBe(staged.id);
    expect(f.apply).not.toHaveBeenCalled();
  });
  it('serializes concurrent admission and releases capacity after a failed creation write', async () => {
    const f = fixture();
    for (let i = 0; i < 127; i++) await f.broker.request('session', `/pending-${i}`, 'Install tool');
    let finish!: () => void;
    let started!: () => void;
    const writing = new Promise<void>(resolve => { started = resolve; });
    f.changed.mockImplementationOnce(() => { started(); return new Promise<void>(resolve => { finish = resolve; }); });
    const last = f.broker.request('session', '/last', 'Install tool');
    await writing;
    const overflow = f.broker.request('session', '/overflow', 'Install tool');
    const rejected = expect(overflow).rejects.toThrow('REQUEST_LIMIT_REACHED');
    finish(); await last; await rejected;
    expect(f.broker.list('session').filter(request => request.state === 'pending')).toHaveLength(128);
    await f.broker.cancel('session', (await last).id);
    f.changed.mockRejectedValueOnce(new Error('journal failed'));
    await expect(f.broker.request('session', '/retry', 'Install tool')).rejects.toThrow('journal failed');
    expect((await f.broker.request('session', '/retry', 'Install tool')).state).toBe('pending');
  });

  it('keeps a newly persisted request in later snapshots while another request is cancelled', async () => {
    const f = fixture();
    const existing = await f.broker.request('session', '/existing', 'Install tool');
    let finish!: () => void, started!: () => void;
    const writing = new Promise<void>(resolve => { started = resolve; });
    f.changed.mockImplementationOnce(() => { started(); return new Promise<void>(resolve => { finish = resolve; }); });
    const admission = f.broker.request('session', '/new', 'Install tool');
    await writing;
    const cancelled = f.broker.cancel('session', existing.id);
    finish(); const added = await admission; await cancelled;
    expect(f.changed.mock.calls.at(-1)![0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: existing.id, state: 'cancelled' }),
      expect.objectContaining({ id: added.id, state: 'pending' }),
    ]));
  });

});
