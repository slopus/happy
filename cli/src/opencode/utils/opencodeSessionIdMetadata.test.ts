import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import { maybeUpdateOpenCodeSessionIdMetadata } from './opencodeSessionIdMetadata';

describe('maybeUpdateOpenCodeSessionIdMetadata', () => {
  it('no-ops when session id is missing', () => {
    const lastPublished = { value: null as string | null };
    let called = 0;

    maybeUpdateOpenCodeSessionIdMetadata({
      getOpenCodeSessionId: () => null,
      updateHappySessionMetadata: () => {
        called++;
      },
      lastPublished,
    });

    expect(called).toBe(0);
    expect(lastPublished.value).toBeNull();
  });

  it('publishes opencodeSessionId once per new session id and preserves other metadata', () => {
    const lastPublished = { value: null as string | null };
    const updates: Metadata[] = [];

    const apply = (updater: (m: Metadata) => Metadata) => {
      const base = { path: '/tmp', flavor: 'opencode' } as unknown as Metadata;
      updates.push(updater(base));
    };

    maybeUpdateOpenCodeSessionIdMetadata({
      getOpenCodeSessionId: () => ' session-1 ',
      updateHappySessionMetadata: apply,
      lastPublished,
    });

    maybeUpdateOpenCodeSessionIdMetadata({
      getOpenCodeSessionId: () => 'session-1',
      updateHappySessionMetadata: apply,
      lastPublished,
    });

    maybeUpdateOpenCodeSessionIdMetadata({
      getOpenCodeSessionId: () => 'session-2',
      updateHappySessionMetadata: apply,
      lastPublished,
    });

    expect(updates).toEqual([
      { path: '/tmp', flavor: 'opencode', opencodeSessionId: 'session-1' } as unknown as Metadata,
      { path: '/tmp', flavor: 'opencode', opencodeSessionId: 'session-2' } as unknown as Metadata,
    ]);
  });
});

