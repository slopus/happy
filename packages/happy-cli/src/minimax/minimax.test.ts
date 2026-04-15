/**
 * MiniMax Unit Tests
 *
 * Tests for MiniMax constants and configuration.
 */

import { describe, it, expect } from 'vitest';
import {
  MINIMAX_API_KEY_ENV,
  MINIMAX_BASE_URL_ENV,
  DEFAULT_MINIMAX_BASE_URL,
  DEFAULT_MINIMAX_MODEL,
  MINIMAX_HIGHSPEED_MODEL,
} from './constants';

describe('MiniMax constants', () => {
  it('exports the correct API key env var name', () => {
    expect(MINIMAX_API_KEY_ENV).toBe('MINIMAX_API_KEY');
  });

  it('exports the correct base URL env var name', () => {
    expect(MINIMAX_BASE_URL_ENV).toBe('MINIMAX_BASE_URL');
  });

  it('exports the correct default base URL', () => {
    expect(DEFAULT_MINIMAX_BASE_URL).toBe('https://api.minimax.io');
  });

  it('exports a valid default model', () => {
    expect(DEFAULT_MINIMAX_MODEL).toBe('MiniMax-M2.7');
  });

  it('exports a valid high-speed model', () => {
    expect(MINIMAX_HIGHSPEED_MODEL).toBe('MiniMax-M2.7-highspeed');
  });
});
