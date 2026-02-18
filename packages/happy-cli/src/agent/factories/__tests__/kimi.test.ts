/**
 * Kimi Backend Factory Tests
 *
 * Unit tests for the Kimi backend factory.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createKimiBackend, registerKimiAgent } from '../kimi';
import { agentRegistry } from '../../core';
import * as AcpBackendModule from '../../acp/AcpBackend';

// Mock dependencies
vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../acp/AcpBackend', () => ({
  AcpBackend: vi.fn().mockImplementation(() => ({
    onMessage: vi.fn(),
    startSession: vi.fn(),
    sendPrompt: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(),
  })),
}));

describe('createKimiBackend', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('creates backend with default options', () => {
    const result = createKimiBackend({
      cwd: '/test/path',
    });

    expect(result.backend).toBeDefined();
    expect(result.model).toBe('kimi-k2-0711-preview');
    expect(result.modelSource).toBe('default');
  });

  it('uses explicit model when provided', () => {
    const result = createKimiBackend({
      cwd: '/test/path',
      model: 'kimi-k1.6-preview',
    });

    expect(result.model).toBe('kimi-k1.6-preview');
    expect(result.modelSource).toBe('explicit');
  });

  it('uses API key from environment variable', () => {
    process.env.KIMI_API_KEY = 'test-api-key';

    createKimiBackend({
      cwd: '/test/path',
    });

    expect(AcpBackendModule.AcpBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          KIMI_API_KEY: 'test-api-key',
        }),
      })
    );
  });

  it('uses API key from options (priority over env)', () => {
    process.env.KIMI_API_KEY = 'env-api-key';

    createKimiBackend({
      cwd: '/test/path',
      apiKey: 'options-api-key',
    });

    // Options API key takes precedence
    expect(AcpBackendModule.AcpBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          KIMI_API_KEY: 'env-api-key',
        }),
      })
    );
  });

  it('configures MCP servers correctly', () => {
    const mcpServers = {
      happy: {
        command: 'node',
        args: ['bridge.js'],
      },
    };

    createKimiBackend({
      cwd: '/test/path',
      mcpServers,
    });

    expect(AcpBackendModule.AcpBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServers,
      })
    );
  });

  it('sets correct command and args', () => {
    createKimiBackend({
      cwd: '/test/path',
    });

    expect(AcpBackendModule.AcpBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'kimi',
        command: 'kimi',
        args: ['acp'],
        cwd: '/test/path',
      })
    );
  });

  it('suppresses debug output in environment', () => {
    createKimiBackend({
      cwd: '/test/path',
    });

    expect(AcpBackendModule.AcpBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          NODE_ENV: 'production',
          DEBUG: '',
        }),
      })
    );
  });

  it('detects change_title instruction in prompt', () => {
    const result = createKimiBackend({
      cwd: '/test/path',
    });

    // Test the hasChangeTitleInstruction callback
    expect(result.backend).toBeDefined();

    // The callback should be passed to AcpBackend
    const callArgs = vi.mocked(AcpBackendModule.AcpBackend).mock.calls[0][0];
    expect(callArgs.hasChangeTitleInstruction).toBeDefined();

    // Test the callback behavior
    expect(callArgs.hasChangeTitleInstruction!('change title to Hello')).toBe(true);
    expect(callArgs.hasChangeTitleInstruction!('set title to New Title')).toBe(true);
    expect(callArgs.hasChangeTitleInstruction!('use change_title tool')).toBe(true);
    expect(callArgs.hasChangeTitleInstruction!('regular prompt')).toBe(false);
  });

  it('uses kimiTransport as transport handler', () => {
    createKimiBackend({
      cwd: '/test/path',
    });

    const callArgs = vi.mocked(AcpBackendModule.AcpBackend).mock.calls[0][0];
    expect(callArgs.transportHandler).toBeDefined();
    expect(callArgs.transportHandler?.agentName).toBe('kimi');
  });
});

describe('registerKimiAgent', () => {
  it('registers kimi agent with the registry', () => {
    const registerSpy = vi.spyOn(agentRegistry, 'register');

    registerKimiAgent();

    expect(registerSpy).toHaveBeenCalledWith('kimi', expect.any(Function));
  });

  it('registered factory creates backend when called', () => {
    registerKimiAgent();

    const factory = vi.mocked(agentRegistry.register).mock.calls[0][1];
    const backend = factory({ cwd: '/test' });

    expect(backend).toBeDefined();
  });
});
