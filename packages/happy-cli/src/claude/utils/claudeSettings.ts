import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@/ui/logger';

/** Leave explicit commit attribution to Claude Code. */
export async function shouldIncludeCoAuthoredBy(cwd: string): Promise<boolean> {
  try {
    const { effective } = await resolveSettings({ cwd, settingSources: ['user', 'project', 'local'] });
    const attribution = effective.attribution;
    if (attribution === false || (typeof attribution === 'object' && attribution?.commit !== undefined)) {
      return false;
    }
    return effective.includeCoAuthoredBy !== false;
  } catch {
    logger.debug('[ClaudeSettings] Could not resolve Claude attribution settings');
    return false;
  }
}
