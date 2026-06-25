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
  MINIMAX_M27_MODEL,
  MINIMAX_HIGHSPEED_MODEL,
  SUPPORTED_MINIMAX_MODELS,
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

  it('uses MiniMax-M3 as the default model', () => {
    expect(DEFAULT_MINIMAX_MODEL).toBe('MiniMax-M3');
  });

  it('exposes MiniMax-M2.7 as the previous-generation alternative', () => {
    expect(MINIMAX_M27_MODEL).toBe('MiniMax-M2.7');
  });

  it('exposes MiniMax-M2.7-highspeed as the high-speed alternative', () => {
    expect(MINIMAX_HIGHSPEED_MODEL).toBe('MiniMax-M2.7-highspeed');
  });

  it('lists supported models with the default (M3) first', () => {
    expect(SUPPORTED_MINIMAX_MODELS[0]).toBe('MiniMax-M3');
    expect(SUPPORTED_MINIMAX_MODELS).toContain('MiniMax-M2.7');
    expect(SUPPORTED_MINIMAX_MODELS).toContain('MiniMax-M2.7-highspeed');
  });

  it('does not list older models (M2.5/M2.1/M2/M1)', () => {
    for (const model of SUPPORTED_MINIMAX_MODELS) {
      expect(model).not.toBe('MiniMax-M2.5');
      expect(model).not.toBe('MiniMax-M2.1');
      expect(model).not.toBe('MiniMax-M2');
      expect(model).not.toBe('MiniMax-M1');
    }
  });
});
