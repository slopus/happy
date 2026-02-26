/**
 * Kimi Constants Tests
 *
 * Tests for Kimi constant values.
 */

import { describe, expect, it } from 'vitest';
import {
  KIMI_API_KEY_ENV,
  DEFAULT_KIMI_MODEL,
  AVAILABLE_KIMI_MODELS,
  CHANGE_TITLE_INSTRUCTION,
} from '../constants';

describe('Kimi Constants', () => {
  describe('KIMI_API_KEY_ENV', () => {
    it('is set to correct environment variable name', () => {
      expect(KIMI_API_KEY_ENV).toBe('KIMI_API_KEY');
    });
  });

  describe('DEFAULT_KIMI_MODEL', () => {
    it('is set to a valid model', () => {
      expect(DEFAULT_KIMI_MODEL).toBeDefined();
      expect(typeof DEFAULT_KIMI_MODEL).toBe('string');
      expect(DEFAULT_KIMI_MODEL.length).toBeGreaterThan(0);
    });

    it('is included in available models', () => {
      expect(AVAILABLE_KIMI_MODELS).toContain(DEFAULT_KIMI_MODEL);
    });
  });

  describe('AVAILABLE_KIMI_MODELS', () => {
    it('is a non-empty array', () => {
      expect(Array.isArray(AVAILABLE_KIMI_MODELS)).toBe(true);
      expect(AVAILABLE_KIMI_MODELS.length).toBeGreaterThan(0);
    });

    it('contains only strings', () => {
      AVAILABLE_KIMI_MODELS.forEach(model => {
        expect(typeof model).toBe('string');
        expect(model.length).toBeGreaterThan(0);
      });
    });

    it('contains expected models', () => {
      // Check for some expected models
      expect(AVAILABLE_KIMI_MODELS.some(m => m.includes('kimi'))).toBe(true);
    });

    it('has no duplicate models', () => {
      const uniqueModels = new Set(AVAILABLE_KIMI_MODELS);
      expect(uniqueModels.size).toBe(AVAILABLE_KIMI_MODELS.length);
    });
  });

  describe('CHANGE_TITLE_INSTRUCTION', () => {
    it('contains change_title keyword', () => {
      expect(CHANGE_TITLE_INSTRUCTION).toContain('change_title');
    });

    it('is a string', () => {
      expect(typeof CHANGE_TITLE_INSTRUCTION).toBe('string');
    });

    it('contains instructions for the agent', () => {
      expect(CHANGE_TITLE_INSTRUCTION.length).toBeGreaterThan(10);
    });
  });
});
