/**
 * The fully-qualified MCP tool name for Happy's `change_title` tool, which lets
 * agents rename the current session. Each agent (Claude, Gemini, Codex) exposes
 * this MCP tool, plus a few legacy variants (`change_title`, `change-title`,
 * `happy__change_title`); the constant below de-duplicates the spec-correct
 * form across permission whitelists, transport pattern lists, and prompt
 * heuristics so the canonical string lives in one place.
 */
export const HAPPY_CHANGE_TITLE_TOOL_NAME = 'mcp__happy__change_title' as const;
