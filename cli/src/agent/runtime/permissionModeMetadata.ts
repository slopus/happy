import type { PermissionMode } from '@/api/types';

export function maybeUpdatePermissionModeMetadata(opts: {
  currentPermissionMode: PermissionMode | undefined;
  nextPermissionMode: PermissionMode;
  updateMetadata: (updater: (current: any) => any) => void;
  nowMs?: () => number;
}): { didChange: boolean; currentPermissionMode: PermissionMode } {
  if (opts.currentPermissionMode === opts.nextPermissionMode) {
    return { didChange: false, currentPermissionMode: opts.nextPermissionMode };
  }

  const nowMs = opts.nowMs ?? Date.now;
  opts.updateMetadata((current) => ({
    ...current,
    permissionMode: opts.nextPermissionMode,
    permissionModeUpdatedAt: nowMs(),
  }));

  return { didChange: true, currentPermissionMode: opts.nextPermissionMode };
}

