import { describe, it, expect, vi } from 'vitest';
import { maybeUpdatePermissionModeMetadata } from './permissionModeMetadata';

describe('maybeUpdatePermissionModeMetadata', () => {
  it("doesn't bump permissionModeUpdatedAt when permission mode is unchanged", () => {
    const updateMetadata = vi.fn();
    const nowMs = () => 123;

    const res = maybeUpdatePermissionModeMetadata({
      currentPermissionMode: 'acceptEdits',
      nextPermissionMode: 'acceptEdits',
      updateMetadata,
      nowMs,
    });

    expect(res).toEqual({ didChange: false, currentPermissionMode: 'acceptEdits' });
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it('bumps permissionModeUpdatedAt when permission mode changes', () => {
    const updateMetadata = vi.fn();
    const nowMs = () => 456;

    const res = maybeUpdatePermissionModeMetadata({
      currentPermissionMode: 'default',
      nextPermissionMode: 'bypassPermissions',
      updateMetadata,
      nowMs,
    });

    expect(res).toEqual({ didChange: true, currentPermissionMode: 'bypassPermissions' });
    expect(updateMetadata).toHaveBeenCalledTimes(1);
    const updater = updateMetadata.mock.calls[0]?.[0];
    expect(typeof updater).toBe('function');
    expect(updater({ somethingElse: 1 })).toEqual({
      somethingElse: 1,
      permissionMode: 'bypassPermissions',
      permissionModeUpdatedAt: 456,
    });
  });
});

