import { describe, expect, it } from 'vitest';
import { createKimiBackend, registerKimiAgent } from './kimi';
import { agentRegistry } from '../core';

describe('createKimiBackend', () => {
  it('creates a backend with default options', () => {
    const result = createKimiBackend({ cwd: '/tmp' });
    expect(result.backend).toBeDefined();
    expect(result.model).toBeNull();
  });

  it('passes through apiKey and model', () => {
    const result = createKimiBackend({
      cwd: '/tmp',
      apiKey: 'test-key',
      model: 'kimi-k2.6',
    });
    expect(result.backend).toBeDefined();
    expect(result.model).toBe('kimi-k2.6');
  });
});

describe('registerKimiAgent', () => {
  it('registers kimi in the global agent registry', () => {
    registerKimiAgent();
    expect(agentRegistry.has('kimi')).toBe(true);
    expect(agentRegistry.list()).toContain('kimi');
  });
});
