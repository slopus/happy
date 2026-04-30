/**
 * Copilot Transport Handler
 *
 * Transport handler for GitHub Copilot CLI ACP mode.
 * Copilot's ACP server can have gaps >500ms between streaming chunks,
 * so we use a longer idle timeout to avoid premature turn completion.
 *
 * @module CopilotTransport
 */

import { DefaultTransport } from '../DefaultTransport';

const COPILOT_TIMEOUTS = {
  /** Copilot CLI startup can take time for auth/init */
  init: 120_000,
  /** Idle detection — Copilot streams chunkier than Gemini, needs longer gap tolerance */
  idle: 2_000,
} as const;

/**
 * Transport handler for GitHub Copilot CLI.
 *
 * Extends DefaultTransport with Copilot-specific timeout tuning.
 */
export class CopilotTransport extends DefaultTransport {
  constructor() {
    super('copilot');
  }

  getInitTimeout(): number {
    return COPILOT_TIMEOUTS.init;
  }

  getIdleTimeout(): number {
    return COPILOT_TIMEOUTS.idle;
  }
}

export const copilotTransport = new CopilotTransport();
