import { describe, expect, it, vi } from 'vitest';
import {
  discoverAgyModels,
  getStaticAgyModels,
  parseAgyModelsOutput,
  resolveAgyModelName,
  type ExecFileFn,
} from './discoverModels';
import { AGY_MODELS } from './constants';

describe('discoverModels', () => {
  describe('parseAgyModelsOutput', () => {
    it('parses tab-separated agy models output', () => {
      const sample = `Fetching available models...
gemini-3.7-flash-high\tGemini 3.7 Flash (High)
gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)
gemini-3.6-flash-high\tGemini 3.6 Flash (High)
claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)
`;
      const models = parseAgyModelsOutput(sample);
      expect(models).toEqual([
        {
          code: 'Gemini 3.7 Flash (High)',
          value: 'Gemini 3.7 Flash (High)',
          slug: 'gemini-3.7-flash-high',
          description: null,
        },
        {
          code: 'Gemini 3.7 Flash (Medium)',
          value: 'Gemini 3.7 Flash (Medium)',
          slug: 'gemini-3.7-flash-medium',
          description: null,
        },
        {
          code: 'Gemini 3.6 Flash (High)',
          value: 'Gemini 3.6 Flash (High)',
          slug: 'gemini-3.6-flash-high',
          description: null,
        },
        {
          code: 'Claude Opus 4.6 (Thinking)',
          value: 'Claude Opus 4.6 (Thinking)',
          slug: 'claude-opus-4-6-thinking',
          description: null,
        },
      ]);
    });

    it('parses space-aligned agy models output and ignores spinners/headers', () => {
      const sample = `⠋ Fetching available models...⠙ Fetching available models...
gemini-3.7-flash-high     Gemini 3.7 Flash (High)
gemini-3.7-flash-low      Gemini 3.7 Flash (Low)
gpt-oss-120b-medium       GPT-OSS 120B (Medium)
`;
      const models = parseAgyModelsOutput(sample);
      expect(models).toEqual([
        {
          code: 'Gemini 3.7 Flash (High)',
          value: 'Gemini 3.7 Flash (High)',
          slug: 'gemini-3.7-flash-high',
          description: null,
        },
        {
          code: 'Gemini 3.7 Flash (Low)',
          value: 'Gemini 3.7 Flash (Low)',
          slug: 'gemini-3.7-flash-low',
          description: null,
        },
        {
          code: 'GPT-OSS 120B (Medium)',
          value: 'GPT-OSS 120B (Medium)',
          slug: 'gpt-oss-120b-medium',
          description: null,
        },
      ]);
    });

    it('deduplicates duplicate model entries', () => {
      const sample = `
gemini-3.7-flash-high\tGemini 3.7 Flash (High)
gemini-3.7-flash-high\tGemini 3.7 Flash (High)
`;
      const models = parseAgyModelsOutput(sample);
      expect(models).toHaveLength(1);
    });

    it('returns empty array on empty or invalid input', () => {
      expect(parseAgyModelsOutput('')).toEqual([]);
      expect(parseAgyModelsOutput(null as unknown as string)).toEqual([]);
    });
  });

  describe('getStaticAgyModels', () => {
    it('returns all static AGY_MODELS formatted for session metadata', () => {
      const staticModels = getStaticAgyModels();
      expect(staticModels.map((m) => m.code)).toEqual(AGY_MODELS);
      expect(staticModels.some((m) => m.code === 'Gemini 3.7 Flash (High)')).toBe(true);
    });
  });

  describe('discoverAgyModels', () => {
    it('returns parsed models when agy models succeeds', async () => {
      const mockExecFile: ExecFileFn = ((
        _bin: string,
        _args: string[],
        _opts: any,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(
          null,
          'gemini-3.7-flash-high\tGemini 3.7 Flash (High)\ngemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)\n',
          '',
        );
      }) as unknown as ExecFileFn;

      const models = await discoverAgyModels({ execFileFn: mockExecFile });
      expect(models).toHaveLength(2);
      expect(models[0].code).toBe('Gemini 3.7 Flash (High)');
      expect(models[1].code).toBe('Gemini 3.7 Flash (Medium)');
    });

    it('falls back to static models when agy models fails', async () => {
      const mockExecFile: ExecFileFn = ((
        _bin: string,
        _args: string[],
        _opts: any,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(new Error('command not found: agy'), '', '');
      }) as unknown as ExecFileFn;

      const log = vi.fn();
      const models = await discoverAgyModels({ execFileFn: mockExecFile, log });
      expect(models.map((m) => m.code)).toEqual(AGY_MODELS);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Failed to discover agy models dynamically'));
    });
  });

  describe('resolveAgyModelName', () => {
    const customModels = [
      { code: 'Gemini 3.7 Flash (High)', value: 'Gemini 3.7 Flash (High)', slug: 'gemini-3.7-flash-high' },
      { code: 'Claude Opus 4.6 (Thinking)', value: 'Claude Opus 4.6 (Thinking)', slug: 'claude-opus-4-6-thinking' },
    ];

    it('resolves slug to canonical display name', () => {
      expect(resolveAgyModelName('gemini-3.7-flash-high', customModels)).toBe('Gemini 3.7 Flash (High)');
      expect(resolveAgyModelName('claude-opus-4-6-thinking', customModels)).toBe('Claude Opus 4.6 (Thinking)');
    });

    it('preserves exact display name', () => {
      expect(resolveAgyModelName('Gemini 3.7 Flash (High)', customModels)).toBe('Gemini 3.7 Flash (High)');
    });

    it('handles case-insensitive display name match', () => {
      expect(resolveAgyModelName('gemini 3.7 flash (high)', customModels)).toBe('Gemini 3.7 Flash (High)');
    });

    it('returns unknown model as-is', () => {
      expect(resolveAgyModelName('custom-model-9', customModels)).toBe('custom-model-9');
      expect(resolveAgyModelName(undefined, customModels)).toBeUndefined();
    });
  });
});
