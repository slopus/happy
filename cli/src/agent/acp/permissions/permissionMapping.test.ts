import { describe, it, expect } from 'vitest';
import { pickPermissionOutcome, pickPermissionOptionId } from './permissionMapping';

describe('ACP permission mapping', () => {
  it('prefers allow_once by kind for approved', () => {
    const options = [
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'reject-once', kind: 'reject_once' },
    ];
    expect(pickPermissionOptionId(options, 'approved')).toBe('allow-once');
    expect(pickPermissionOutcome(options, 'approved')).toEqual({ outcome: 'selected', optionId: 'allow-once' });
  });

  it('maps approved_for_session to allow_always by kind', () => {
    const options = [
      { optionId: 'ask', kind: 'allow_once' },
      { optionId: 'code', kind: 'allow_always' },
      { optionId: 'reject', kind: 'reject_once' },
    ];
    expect(pickPermissionOptionId(options, 'approved_for_session')).toBe('code');
  });

  it('maps denied to reject-once optionId when kind missing', () => {
    const options = [
      { optionId: 'allow-once' },
      { optionId: 'reject-once' },
    ];
    expect(pickPermissionOptionId(options, 'denied')).toBe('reject-once');
  });

  it('maps abort to cancelled outcome', () => {
    const options = [
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'reject-once', kind: 'reject_once' },
    ];
    expect(pickPermissionOutcome(options, 'abort')).toEqual({ outcome: 'cancelled' });
  });
});

