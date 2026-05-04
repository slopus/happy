import type { CodexPermissionMode } from '@/codex/modeState';

export type ResumeControlOptions = {
  model?: string;
  permissionMode?: string;
};

export type NormalizedCodexResumeOptions = {
  model?: string;
  permissionMode?: CodexPermissionMode;
};

const CODEX_PERMISSION_MODES = new Set<CodexPermissionMode>([
  'read-only',
  'safe-yolo',
  'yolo',
]);

export function normalizeCodexResumeOptions(options?: ResumeControlOptions): NormalizedCodexResumeOptions {
  const normalized: NormalizedCodexResumeOptions = {};

  const model = options?.model?.trim();
  if (model && model !== 'default') {
    normalized.model = model;
  }

  const permissionMode = options?.permissionMode?.trim();
  if (permissionMode && CODEX_PERMISSION_MODES.has(permissionMode as CodexPermissionMode)) {
    normalized.permissionMode = permissionMode as CodexPermissionMode;
  }

  return normalized;
}
