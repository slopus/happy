/**
 * Shared footer copy for read-only terminal displays.
 *
 * These displays intentionally do not accept prompts from stdin; users should
 * interact via the Happy app/web until an interactive terminal mode exists for
 * the provider.
 */

export function buildReadOnlyFooterLines(providerName: string): string[] {
  const name = providerName.trim().length > 0 ? providerName.trim() : 'this provider';
  return [
    "Logs only — you can’t send prompts from this terminal.",
    `Use the Happy app/web (interactive terminal mode isn’t supported for ${name}).`,
  ];
}

