import { describe, expect, it } from 'vitest';
import { isCommittedMessageDiscarded } from './discardedCommittedMessages';

describe('isCommittedMessageDiscarded', () => {
  it('returns false when metadata is missing', () => {
    expect(isCommittedMessageDiscarded(null, 'x')).toBe(false);
  });

  it('returns false when localId is missing', () => {
    expect(isCommittedMessageDiscarded({} as any, null)).toBe(false);
  });

  it('returns true when localId is included in discardedCommittedMessageLocalIds', () => {
    expect(isCommittedMessageDiscarded({ discardedCommittedMessageLocalIds: ['a'] } as any, 'a')).toBe(true);
  });

  it('returns false when localId is not included in discardedCommittedMessageLocalIds', () => {
    expect(isCommittedMessageDiscarded({ discardedCommittedMessageLocalIds: ['a'] } as any, 'b')).toBe(false);
  });
});

