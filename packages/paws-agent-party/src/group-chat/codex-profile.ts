/** Browser-safe Codex launch-profile values shared by the management UI and service. */
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-luna';
export const DEFAULT_CODEX_EFFORT = 'low';
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type CodexModel = string;
export type CodexEffort = typeof CODEX_EFFORTS[number];

export function isCodexModel(value: unknown): value is CodexModel {
  // Codex owns the actual catalog. Keep this field future-compatible without
  // accepting control characters or command-shaped input into the launch path.
  return typeof value === 'string' && /^gpt-[a-zA-Z0-9._-]{1,120}$/u.test(value);
}

export function isCodexEffort(value: unknown): value is CodexEffort {
  return typeof value === 'string' && (CODEX_EFFORTS as readonly string[]).includes(value);
}
