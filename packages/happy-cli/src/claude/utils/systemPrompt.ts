import { trimIdent } from "@/utils/trimIdent";
import { shouldIncludeCoAuthoredBy } from "./claudeSettings";

/**
 * Base system prompt shared across all configurations
 */
const BASE_SYSTEM_PROMPT = (() => trimIdent(`
    You MUST call the "mcp__happy__change_title" tool to set and maintain an accurate chat title. This title is how the user identifies sessions at a glance across multiple machines and projects. Follow these rules:

    1. IMMEDIATELY on your first response — set a title based on the user's first message.
    2. Once you understand the real goal — update the title to be more specific (this often applies after the first exchange).
    3. When the conversation's focus shifts significantly — update the title to reflect the new focus.
    4. When you complete a major task and move on to something new — update the title.

    Title guidelines:
    - Keep titles short (under 50 characters) and action-oriented.
    - Describe WHAT is being done, not WHERE (the project path is shown separately).
    - Good: "Fix auth token refresh", "Add dark mode toggle", "Debug flaky CI tests"
    - Bad: "happy-repo", "Working on code", "Helping with project", "Chat"
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
 * System prompt with conditional Co-Authored-By lines based on Claude's settings.json configuration.
 * Settings are read once on startup for performance.
 */
export const systemPrompt = (() => {
  const includeCoAuthored = shouldIncludeCoAuthoredBy();
  
  if (includeCoAuthored) {
    return BASE_SYSTEM_PROMPT + '\n\n' + CO_AUTHORED_CREDITS;
  } else {
    return BASE_SYSTEM_PROMPT;
  }
})();