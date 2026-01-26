import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('setGeminiModelConfig', () => {
  it('writes config.json under ~/.gemini with model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happy-gemini-config-'));
    const { setGeminiModelConfig } = await import('./setGeminiModelConfig');

    const { configPath } = setGeminiModelConfig({ homeDir: dir, model: 'gemini-2.5-pro' });
    expect(configPath).toBe(join(dir, '.gemini', 'config.json'));

    const json = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(json).toMatchObject({ model: 'gemini-2.5-pro' });
  });

  it('preserves existing config keys when updating model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happy-gemini-config-'));
    const configPath = join(dir, '.gemini', 'config.json');
    const configDir = join(dir, '.gemini');

    // Create existing config
    await import('node:fs').then(({ mkdirSync }) => mkdirSync(configDir, { recursive: true }));
    writeFileSync(configPath, JSON.stringify({ foo: 'bar', model: 'old' }, null, 2), 'utf-8');

    const { setGeminiModelConfig } = await import('./setGeminiModelConfig');
    setGeminiModelConfig({ homeDir: dir, model: 'gemini-2.5-flash' });

    const json = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(json).toMatchObject({ foo: 'bar', model: 'gemini-2.5-flash' });
  });
});

