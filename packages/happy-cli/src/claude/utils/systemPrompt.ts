import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { trimIdent } from "@/utils/trimIdent";
import { shouldIncludeCoAuthoredBy } from "./claudeSettings";
import { logger } from '@/ui/logger';

/**
 * Base system prompt shared across all configurations
 */
const BASE_SYSTEM_PROMPT = (() => trimIdent(`
    ALWAYS when you start a new chat - you must call a tool "mcp__happy__change_title" to set a chat title. When you think chat title is not relevant anymore - call the tool again to change it. When chat name is too generic and you have a change to make it more specific - call the tool again to change it. This title is needed to easily find the chat in the future. Help human.
`))();

/**
 * Co-authored-by credits to append when enabled
 */
const CO_AUTHORED_CREDITS = (() => trimIdent(`
    When making commit messages, instead of just giving co-credit to Claude, also give credit to Happy like so:

    <main commit message>

    Generated with [Claude Code](https://claude.ai/code)
    via [Happy](https://happy.engineering)

    Co-Authored-By: Claude <noreply@anthropic.com>
    Co-Authored-By: Happy <yesreply@happy.engineering>
`))();

/**
 * Load user's custom system prompt from a dotfile.
 *
 * Resolution order:
 *   1. HAPPY_SYSTEM_PROMPT_FILE env var (explicit path)
 *   2. $HAPPY_HOME_DIR/system-prompt.md (follows existing ~/.happy/ convention)
 *   3. ~/.happy/system-prompt.md (default)
 *
 * Returns the file contents if found, or null.
 */
function loadUserSystemPrompt(): string | null {
  const explicitPath = process.env.HAPPY_SYSTEM_PROMPT_FILE;
  const happyHome = process.env.HAPPY_HOME_DIR?.replace(/^~/, homedir()) || join(homedir(), '.happy');
  const defaultPath = join(happyHome, 'system-prompt.md');

  const filePath = explicitPath || defaultPath;

  try {
    if (!existsSync(filePath)) {
      if (explicitPath) {
        logger.debug(`[SystemPrompt] HAPPY_SYSTEM_PROMPT_FILE set but file not found: ${filePath}`);
      }
      return null;
    }

    const content = readFileSync(filePath, 'utf-8').trim();
    if (!content) {
      return null;
    }

    logger.debug(`[SystemPrompt] Loaded user system prompt from ${filePath} (${content.length} chars)`);
    return content;
  } catch (error) {
    logger.debug(`[SystemPrompt] Error reading ${filePath}: ${error}`);
    return null;
  }
}

/**
 * System prompt assembled once on startup from:
 *   - Base prompt (title-setting)
 *   - Co-Authored-By credits (if enabled in Claude settings)
 *   - User's custom system prompt file (if present)
 */
export const systemPrompt = (() => {
  const parts = [BASE_SYSTEM_PROMPT];

  if (shouldIncludeCoAuthoredBy()) {
    parts.push(CO_AUTHORED_CREDITS);
  }

  const userPrompt = loadUserSystemPrompt();
  if (userPrompt) {
    parts.push(userPrompt);
  }

  return parts.join('\n\n');
})();
