import { describe, expect, it } from 'vitest';

import { maybeUpdateAuggieSessionIdMetadata } from './auggieSessionIdMetadata';

describe('maybeUpdateAuggieSessionIdMetadata', () => {
  it('publishes auggieSessionId once per new session id and preserves other metadata', () => {
    const published: any[] = [];
    const last = { value: null as string | null };

    maybeUpdateAuggieSessionIdMetadata({
      getAuggieSessionId: () => 'a1',
      updateHappySessionMetadata: (updater) => published.push(updater({ keep: true } as any)),
      lastPublished: last,
    });

    maybeUpdateAuggieSessionIdMetadata({
      getAuggieSessionId: () => 'a1',
      updateHappySessionMetadata: (updater) => published.push(updater({ keep: true } as any)),
      lastPublished: last,
    });

    maybeUpdateAuggieSessionIdMetadata({
      getAuggieSessionId: () => 'a2',
      updateHappySessionMetadata: (updater) => published.push(updater({ keep: true } as any)),
      lastPublished: last,
    });

    expect(published).toEqual([
      { keep: true, auggieSessionId: 'a1' },
      { keep: true, auggieSessionId: 'a2' },
    ]);
  });
});

