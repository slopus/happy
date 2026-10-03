import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScopeRequest } from './sessionWriteScope';
import { ScopeJournal } from './sessionWriteScopeJournal';

describe('write scope crash recovery', () => {
  it('retains application uncertainty but never rehydrates a pending permit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scope-journal-'));
    try {
      const journal = new ScopeJournal(join(dir, 'journal.json'), 'account', 'machine');
      const descriptor = { version: 1 as const, id: 'request', digest: 'd'.repeat(64), incarnation: 'old', accountId: 'account',
        machineId: 'machine', sessionId: 'session', generation: '1', projectRoot: '/project', root: '/target',
        requestedPath: '/target', description: 'Install tool', kind: 'grant' as const, createdAt: 1, expiresAt: 2 };
      await journal.write([{ ...descriptor, state: 'pending' }, { ...descriptor, id: 'started', state: 'applying' }]);
      const recovered = await journal.recover();
      expect(recovered.map(item => item.state)).toEqual(['expired', 'cleanup-unresolved']);
      expect(recovered.every(item => item.grantActive === false)).toBe(true);
      expect(await new ScopeJournal(join(dir, 'journal.json'), 'other', 'machine').recover()).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('prunes ordinary recovered history and remains writable across repeated full historical snapshots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scope-journal-'));
    const path = join(dir, 'journal.json');
    const record: ScopeRequest = { version: 1, id: 'request', digest: 'd'.repeat(64), incarnation: 'old', accountId: 'account',
      machineId: 'machine', sessionId: 'session', generation: '1', projectRoot: '/project', root: '/target',
      requestedPath: '/target', description: 'Install tool', kind: 'grant', createdAt: 1, expiresAt: 2, state: 'cancelled' };
    try {
      await writeFile(path, JSON.stringify(Array.from({ length: 512 }, (_, i) => ({ ...record, id: `old-${i}`, createdAt: i }))), { mode: 0o600 });
      let recovered = await new ScopeJournal(path, 'account', 'machine').recover();
      expect(recovered).toHaveLength(128);
      expect(recovered[0].id).toBe('old-384');
      for (let cycle = 0; cycle < 4; cycle++) {
        const journal = new ScopeJournal(path, 'account', 'machine');
        const fresh = Array.from({ length: 128 }, (_, i) => ({ ...record, id: `new-${cycle}-${i}`, createdAt: 1000 + cycle * 128 + i }));
        await journal.write([...recovered, ...fresh]);
        recovered = await new ScopeJournal(path, 'account', 'machine').recover();
        expect(recovered).toHaveLength(128);
        expect(recovered.at(-1)?.id).toBe(`new-${cycle}-127`);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('preserves uncertainty and active records regardless of ordinary history age', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scope-journal-'));
    try {
      const journal = new ScopeJournal(join(dir, 'journal.json'), 'account', 'machine');
      const record: ScopeRequest = { version: 1, id: 'request', digest: 'd'.repeat(64), incarnation: 'old', accountId: 'account',
        machineId: 'machine', sessionId: 'session', generation: '1', projectRoot: '/project', root: '/target',
        requestedPath: '/target', description: 'Install tool', kind: 'grant', createdAt: 1, expiresAt: 2, state: 'cleanup-unresolved' };
      await journal.write([record, { ...record, id: 'active', state: 'applied', grantActive: true },
        ...Array.from({ length: 600 }, (_, i) => ({ ...record, id: `cancel-${i}`, state: 'cancelled' as const, createdAt: i + 2 }))]);
      const recovered = await journal.recover();
      expect(recovered).toHaveLength(130);
      expect(recovered.slice(0, 2).map(item => item.state)).toEqual(['cleanup-unresolved', 'cleanup-unresolved']);
      expect(recovered.every(item => !item.grantActive)).toBe(true);
      const uncertain = Array.from({ length: 512 }, (_, i) => ({ ...record, id: `uncertain-${i}` }));
      await journal.write(uncertain);
      expect(() => journal.write([...uncertain, { ...record, id: 'new', state: 'pending' }])).toThrow('SCOPE_JOURNAL_SAFETY_LIMIT_REACHED');
      expect(await journal.recover()).toHaveLength(512);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('refuses an oversized snapshot before replacing a recoverable journal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scope-journal-'));
    try {
      const journal = new ScopeJournal(join(dir, 'journal.json'), 'account', 'machine');
      const record: ScopeRequest = { version: 1, id: 'request', digest: 'd'.repeat(64), incarnation: 'old', accountId: 'account',
        machineId: 'machine', sessionId: 'session', generation: '1', projectRoot: '/project', root: '/target',
        requestedPath: '/target', description: 'Install tool', kind: 'grant', createdAt: 1, expiresAt: 2, state: 'cleanup-unresolved' };
      await journal.write([record]);
      const longPath = '/' + 'x'.repeat(2047);
      const oversized = Array.from({ length: 300 }, (_, i) => ({ ...record, id: `large-${i}`, root: longPath, requestedPath: longPath }));
      expect(() => journal.write(oversized)).toThrow('SCOPE_JOURNAL_SAFETY_LIMIT_REACHED');
      expect((await journal.recover()).map(item => item.id)).toEqual(['request']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

});
