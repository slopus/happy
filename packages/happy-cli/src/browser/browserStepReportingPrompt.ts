/**
 * Shared agent instruction and MCP affordance for Ego browser-step reporting.
 *
 * Provider integrations import these strings so Codex, Claude, and both Happy
 * MCP registration paths expose one consistent behavioral contract.
 */

export const BROWSER_STEP_REPORTING_INSTRUCTION =
    'Whenever you use `ego-browser`, `ego-ops`, or Ego Lite for browser automation, report every meaningful completed and verified browser round to Happy. At the end of the round, before starting the next Ego browser round, capture the current browser view as a PNG or JPEG and call `mcp__happy__report_browser_step` exactly once with the absolute screenshot path and a short completed-state label. Do not report waits, retries, tiny scrolls, low-level helper calls, failed actions, or unverified states as separate steps. Before completing or closing the Ego task space, always report the final verified browser state. If screenshot capture or reporting fails, continue the browser task only when safe, disclose the missing visual step, and never claim that the panel was updated.';

export const BROWSER_STEP_TOOL_DESCRIPTION =
    'Report one completed and verified Ego browser round with its current PNG/JPEG screenshot. Call after each meaningful Ego browser round and before the next round; the frame appears in the dedicated browser-steps panel, not normal chat.';
