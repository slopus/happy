import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import { maybeUpdateCodexSessionIdMetadata } from './codexSessionIdMetadata';

describe('maybeUpdateCodexSessionIdMetadata', () => {
  it('no-ops when thread id is missing', () => {
    const lastPublished = { value: null as string | null };
    let called = 0;

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => null,
      updateHappySessionMetadata: () => {
        called++;
      },
      lastPublished,
    });

    expect(called).toBe(0);
    expect(lastPublished.value).toBeNull();
  });

  it('publishes codexSessionId once per new thread id and preserves other metadata', () => {
    const lastPublished = { value: null as string | null };
    const updates: Metadata[] = [];

    const apply = (updater: (m: Metadata) => Metadata) => {
      const base = { path: '/tmp', flavor: 'codex' } as unknown as Metadata;
      updates.push(updater(base));
    };

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => ' thread-1 ',
      updateHappySessionMetadata: apply,
      lastPublished,
    });

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-1',
      updateHappySessionMetadata: apply,
      lastPublished,
    });

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-2',
      updateHappySessionMetadata: apply,
      lastPublished,
    });

    expect(updates).toEqual([
      { path: '/tmp', flavor: 'codex', codexSessionId: 'thread-1' } as unknown as Metadata,
      { path: '/tmp', flavor: 'codex', codexSessionId: 'thread-2' } as unknown as Metadata,
    ]);
  });
});

