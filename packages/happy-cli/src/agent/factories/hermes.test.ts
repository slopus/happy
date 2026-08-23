import { describe, expect, it } from 'vitest';
import { createHermesBackend, registerHermesAgent } from './hermes';
import { agentRegistry } from '../core';
import { hermesTransport } from '../transport';

describe('createHermesBackend', () => {
  it('creates a backend implementing the AgentBackend interface', () => {
    const backend = createHermesBackend({ cwd: process.cwd() });
    expect(backend).toBeTruthy();
    expect(typeof backend.startSession).toBe('function');
    expect(typeof backend.sendPrompt).toBe('function');
    expect(typeof backend.cancel).toBe('function');
    expect(typeof backend.onMessage).toBe('function');
    expect(typeof backend.dispose).toBe('function');
  });
});

describe('registerHermesAgent', () => {
  it('registers the hermes factory with the agent registry', () => {
    registerHermesAgent();
    expect(agentRegistry.has('hermes')).toBe(true);
    expect(agentRegistry.list()).toContain('hermes');

    const backend = agentRegistry.create('hermes', { cwd: process.cwd() });
    expect(backend).toBeTruthy();
    expect(typeof backend.startSession).toBe('function');
  });
});

describe('hermesTransport', () => {
  it('reports hermes as its agent name', () => {
    expect(hermesTransport.agentName).toBe('hermes');
  });

  it('extracts known tool names from tool call IDs', () => {
    expect(hermesTransport.extractToolNameFromId('change_title-1765385846663')).toBe('change_title');
    expect(hermesTransport.extractToolNameFromId('mcp__happy__change_title-abc')).toBe('change_title');
    expect(hermesTransport.extractToolNameFromId('save_memory-123')).toBe('save_memory');
    expect(hermesTransport.extractToolNameFromId('think-456')).toBe('think');
    expect(hermesTransport.extractToolNameFromId('HermesReasoning-789')).toBe('HermesReasoning');
    expect(hermesTransport.extractToolNameFromId('unknown-tool-1')).toBeNull();
  });

  it('resolves generic tool kinds via determineToolName (permission path)', () => {
    expect(hermesTransport.determineToolName('other', 'change_title-123', {}, {} as never)).toBe('change_title');
    expect(hermesTransport.determineToolName('Unknown tool', 'think-456', {}, {} as never)).toBe('think');
    // Known tool names pass through unchanged
    expect(hermesTransport.determineToolName('bash', 'toolcall-1', {}, {} as never)).toBe('bash');
    // Unresolvable generic kinds stay generic
    expect(hermesTransport.determineToolName('other', 'xyz-1', {}, {} as never)).toBe('other');
  });

  it('exposes hermes tool patterns for auto-approval', () => {
    const patterns = hermesTransport.getToolPatterns();
    const names = patterns.map((p) => p.name);
    expect(names).toContain('change_title');
    expect(names).toContain('save_memory');
    expect(names).toContain('think');
    expect(names).toContain('HermesReasoning');
  });
});
