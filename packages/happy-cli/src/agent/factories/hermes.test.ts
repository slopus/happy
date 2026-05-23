import { describe, expect, it } from 'vitest';
import { createHermesBackend, registerHermesAgent } from './hermes';
import { agentRegistry } from '../core';

describe('createHermesBackend', () => {
  it('creates a backend with default options', () => {
    const result = createHermesBackend({ cwd: '/tmp' });
    expect(result.backend).toBeDefined();
    expect(result.model).toBeNull();
  });

  it('passes through apiKey and model', () => {
    const result = createHermesBackend({
      cwd: '/tmp',
      apiKey: 'test-key',
      model: 'hermes-4',
    });
    expect(result.backend).toBeDefined();
    expect(result.model).toBe('hermes-4');
  });
});

describe('registerHermesAgent', () => {
  it('registers hermes in the global agent registry', () => {
    registerHermesAgent();
    expect(agentRegistry.has('hermes')).toBe(true);
    expect(agentRegistry.list()).toContain('hermes');
  });
});
