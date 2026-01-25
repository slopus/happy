import type { ApiSessionClient } from '@/api/apiSession';
import { logger } from '@/ui/logger';

export type SlashCommandDetail = {
  command: string;
  description?: string;
};

function normalizeCommandName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
}

export function normalizeAvailableCommands(input: unknown): SlashCommandDetail[] {
  if (!Array.isArray(input)) return [];
  const details: SlashCommandDetail[] = [];
  const seen = new Set<string>();

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const command = normalizeCommandName(obj.name);
    if (!command) continue;
    if (seen.has(command)) continue;
    seen.add(command);
    const description = typeof obj.description === 'string' ? obj.description.trim() : undefined;
    details.push({ command, ...(description ? { description } : {}) });
  }

  details.sort((a, b) => a.command.localeCompare(b.command));
  return details;
}

export function publishSlashCommandsToMetadata(params: {
  session: ApiSessionClient;
  details: SlashCommandDetail[];
}): void {
  const { session, details } = params;
  const names = details.map((d) => d.command);

  try {
    session.updateMetadata((metadata: any) => {
      const prevNames = Array.isArray(metadata?.slashCommands) ? metadata.slashCommands : [];
      const prevDetails = Array.isArray(metadata?.slashCommandDetails) ? metadata.slashCommandDetails : [];
      const sameNames = JSON.stringify(prevNames) === JSON.stringify(names);
      const sameDetails = JSON.stringify(prevDetails) === JSON.stringify(details);
      if (sameNames && sameDetails) return metadata;

      return {
        ...metadata,
        slashCommands: names,
        slashCommandDetails: details,
      };
    });
  } catch (error) {
    logger.debug('[ACP] Failed to publish slash commands to metadata (non-fatal)', { error });
  }
}

