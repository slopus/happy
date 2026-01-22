import { describe, expect, it } from 'vitest';
import { addDiscardedCommittedMessageLocalIds } from './discardedCommittedMessageLocalIds';

describe('addDiscardedCommittedMessageLocalIds', () => {
  it('adds new ids and preserves existing entries', () => {
    const next = addDiscardedCommittedMessageLocalIds(
      { discardedCommittedMessageLocalIds: ['a'] },
      ['b', 'a', 'c'],
      { max: 10 },
    );

    expect(next.discardedCommittedMessageLocalIds).toEqual(['a', 'b', 'c']);
  });

  it('caps the list to the last max entries', () => {
    const next = addDiscardedCommittedMessageLocalIds(
      { discardedCommittedMessageLocalIds: ['a', 'b'] },
      ['c', 'd'],
      { max: 3 },
    );

    expect(next.discardedCommittedMessageLocalIds).toEqual(['b', 'c', 'd']);
  });
});

