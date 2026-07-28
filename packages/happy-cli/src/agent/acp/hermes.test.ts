import { describe, expect, it } from 'vitest';
import { KNOWN_ACP_AGENTS, resolveAcpAgentConfig } from './acpAgentConfig';

describe('KNOWN_ACP_AGENTS', () => {
  it('defines built-in Gemini, OpenCode, and Hermes command mappings', () => {
    expect(KNOWN_ACP_AGENTS).toEqual({
      gemini: { command: 'gemini', args: ['--experimental-acp'] },
      opencode: { command: 'opencode', args: ['acp'] },
      hermes: { command: 'hermes', args: ['acp'] },
    });
  });
});

describe('resolveAcpAgentConfig', () => {
  it('resolves hermes to predefined command + args', () => {
    expect(resolveAcpAgentConfig(['hermes'])).toEqual({
      agentName: 'hermes',
      command: 'hermes',
      args: ['acp'],
    });
  });

  it('appends extra CLI args for hermes', () => {
    expect(resolveAcpAgentConfig(['hermes', '--verbose'])).toEqual({
      agentName: 'hermes',
      command: 'hermes',
      args: ['acp', '--verbose'],
    });
  });

  it('still resolves gemini correctly', () => {
    expect(resolveAcpAgentConfig(['gemini'])).toEqual({
      agentName: 'gemini',
      command: 'gemini',
      args: ['--experimental-acp'],
    });
  });
});
