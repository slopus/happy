import { describe, expect, it } from 'vitest';
import { MetadataSchema } from './storageTypes';

describe('MetadataSchema (discarded committed messages)', () => {
  it('preserves discardedCommittedMessageLocalIds', () => {
    const parsed = MetadataSchema.parse({
      path: '/tmp',
      host: 'localhost',
      discardedCommittedMessageLocalIds: ['local-1'],
    });

    expect(parsed.discardedCommittedMessageLocalIds).toEqual(['local-1']);
  });
});

