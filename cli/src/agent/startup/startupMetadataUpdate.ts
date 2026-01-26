import type { Metadata, PermissionMode } from '@/api/types';

import { mergeSessionMetadataForStartup } from './mergeSessionMetadataForStartup';

export type PermissionModeOverride = {
  mode: PermissionMode;
  updatedAt?: number;
} | null;

export function buildPermissionModeOverride(opts: {
  permissionMode?: PermissionMode;
  permissionModeUpdatedAt?: number;
}): PermissionModeOverride {
  if (typeof opts.permissionMode !== 'string') {
    return null;
  }
  return { mode: opts.permissionMode, updatedAt: opts.permissionModeUpdatedAt };
}

export function applyStartupMetadataUpdateToSession(opts: {
  session: { updateMetadata: (updater: (current: Metadata) => Metadata) => void };
  next: Metadata;
  nowMs?: number;
  permissionModeOverride: PermissionModeOverride;
}): void {
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();

  opts.session.updateMetadata((currentMetadata) =>
    mergeSessionMetadataForStartup({
      current: currentMetadata,
      next: opts.next,
      nowMs,
      permissionModeOverride: opts.permissionModeOverride ?? null,
    })
  );
}

