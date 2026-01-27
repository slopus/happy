import { describe, expect, it } from 'vitest';

import { maybeUpdateGeminiSessionIdMetadata } from './geminiSessionIdMetadata';

describe('maybeUpdateGeminiSessionIdMetadata', () => {
  it('publishes geminiSessionId once per new session id and preserves other metadata', () => {
    const published: any[] = [];
    const last = { value: null as string | null };

    maybeUpdateGeminiSessionIdMetadata({
      getGeminiSessionId: () => 'g1',
      updateHappySessionMetadata: (updater) => published.push(updater({ keep: true } as any)),
      lastPublished: last,
    });

    maybeUpdateGeminiSessionIdMetadata({
      getGeminiSessionId: () => 'g1',
      updateHappySessionMetadata: (updater) => published.push(updater({ keep: true } as any)),
      lastPublished: last,
    });

    maybeUpdateGeminiSessionIdMetadata({
      getGeminiSessionId: () => 'g2',
      updateHappySessionMetadata: (updater) => published.push(updater({ keep: true } as any)),
      lastPublished: last,
    });

    expect(published).toEqual([
      { keep: true, geminiSessionId: 'g1' },
      { keep: true, geminiSessionId: 'g2' },
    ]);
  });
});

