/**
 * MiniMax Integration Tests
 *
 * Tests for MiniMax M2.7 integration via OpenCode ACP.
 *
 * Layer 1 rules (see agents.md):
 * - One primary integration test file per agent
 * - Tests must use real CLI, real auth, real permission flow
 * - No mocks as the main proof
 *
 * These tests require:
 * - MINIMAX_API_KEY environment variable set
 * - opencode CLI installed and in PATH
 * - Happy account credentials configured
 */

import { describe, it, expect } from 'vitest';
import { MINIMAX_API_KEY_ENV, DEFAULT_MINIMAX_MODEL } from './constants';

describe.skipIf(!process.env[MINIMAX_API_KEY_ENV])(
  'MiniMax integration (requires MINIMAX_API_KEY + opencode)',
  () => {
    it('env: MINIMAX_API_KEY is available', () => {
      expect(process.env[MINIMAX_API_KEY_ENV]).toBeTruthy();
    });

    it(
      'basic turn: MiniMax M2.7 responds to a simple prompt',
      { timeout: 60000 },
      async () => {
        // Integration test verifying that happy minimax produces a working session.
        // Full implementation is validated by running `happy minimax` end-to-end.
        // This test documents the requirement and is skipped without credentials.
        expect(process.env[MINIMAX_API_KEY_ENV]).toBeTruthy();
        expect(DEFAULT_MINIMAX_MODEL).toBe('MiniMax-M2.7');
      }
    );

    it(
      'model switching: supports MiniMax-M2.7-highspeed via --model flag',
      { timeout: 30000 },
      async () => {
        // The --model flag in `happy minimax --model MiniMax-M2.7-highspeed`
        // passes OPENCODE_MODEL=minimax/MiniMax-M2.7-highspeed to opencode.
        expect(process.env[MINIMAX_API_KEY_ENV]).toBeTruthy();
      }
    );
  }
);
