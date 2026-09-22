import { describe, expect, it } from 'vitest';
import { isUnusedCodexSession } from './emptyCodexSession';
const ready = { seq: 1, content: { role: 'agent', content: { type: 'event', data: { type: 'ready' } } } };
const metadata = { flavor: 'codex', path: '/project', codexThreadId: 'empty-thread' };
describe('unused Codex session recovery', () => {
  it('recognizes a complete ready-only transcript', () => {
    expect(isUnusedCodexSession(metadata, 1, [ready])).toBe(true);
    expect(isUnusedCodexSession(metadata, 0, [])).toBe(true);
  });
  it.each([
    [1, []], [2, [ready]], [2, [ready, ready]],
    [1, [{ seq: 1, content: null }]],
    [1, [{ seq: 1, content: { role: 'user', content: { type: 'text', text: 'hello' } } }]],
    [1, [{ seq: 1, content: { role: 'agent', content: { type: 'text', text: 'answer' } } }]],
  ])('never resets missing, partial, corrupt, or used history (%s)', (seq, messages) => {
    expect(isUnusedCodexSession(metadata, seq as number, messages as any)).toBe(false);
  });
  it.each([
    { parentSessionId: 'parent' },
    { codexSyncCursor: { threadId: 'empty-thread', turnId: 'turn' } },
    { codexHistoryReplay: { threadId: 'empty-thread', startedAt: 1 } },
  ])('preserves imported or replayed history', extra => {
    expect(isUnusedCodexSession({ ...metadata, ...extra }, 1, [ready])).toBe(false);
  });
});
