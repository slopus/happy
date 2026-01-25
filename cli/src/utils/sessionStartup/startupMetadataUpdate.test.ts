import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';

import {
  applyStartupMetadataUpdateToSession,
  buildPermissionModeOverride,
} from './startupMetadataUpdate';

describe('startupMetadataUpdate', () => {
  it('returns null when no explicit permissionMode is provided', () => {
    expect(buildPermissionModeOverride({})).toBeNull();
  });

  it('builds a permissionMode override when permissionMode is provided', () => {
    expect(buildPermissionModeOverride({ permissionMode: 'yolo', permissionModeUpdatedAt: 123 })).toEqual({
      mode: 'yolo',
      updatedAt: 123,
    });
  });

  it('applies mergeSessionMetadataForStartup via session.updateMetadata', () => {
    const updates: Metadata[] = [];
    const fakeSession = {
      updateMetadata: (updater: (current: Metadata) => Metadata) => {
        const current = {
          lifecycleState: 'archived',
          messageQueueV1: { v: 1, queue: [{ localId: 'a', message: 'hello' }] },
        } as any as Metadata;
        updates.push(updater(current));
      },
    };

    applyStartupMetadataUpdateToSession({
      session: fakeSession,
      next: { hostPid: 42, messageQueueV1: { v: 1, queue: [] } } as any,
      nowMs: 999,
      permissionModeOverride: null,
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].lifecycleState).toBe('running');
    expect((updates[0] as any).hostPid).toBe(42);
    expect((updates[0] as any).messageQueueV1?.queue).toEqual([{ localId: 'a', message: 'hello' }]);
  });
});

