/**
 * Environment variables the Claude CLI picks up on its own to authenticate or
 * to route its requests somewhere else.
 *
 * Any one of these, present in a child's environment, means that child may not
 * be using the login the machine's credential store describes. Three places
 * need the same answer — the Z.AI lease strip, the managed-run scrub, and the
 * observed-source check — so the list lives once, here.
 *
 * Model-selection keys (`ANTHROPIC_MODEL`, …) are deliberately **not** here:
 * they change which model runs, not whose credential pays for it.
 */
export const CLAUDE_AUTH_OVERRIDE_ENV_KEYS = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_CUSTOM_HEADERS',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
] as const
