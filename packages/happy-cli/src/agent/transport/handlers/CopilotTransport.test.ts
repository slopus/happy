import { describe, expect, it } from 'vitest';
import { CopilotTransport, copilotTransport } from './CopilotTransport';

describe('CopilotTransport', () => {
  it('initializes with copilot agent name and configured timeouts', () => {
    const transport = new CopilotTransport();
    expect(transport.agentName).toBe('copilot');
    expect(transport.getInitTimeout()).toBe(120_000);
    expect(transport.getIdleTimeout()).toBe(2_000);
  });

  it('exports singleton instance', () => {
    expect(copilotTransport).toBeInstanceOf(CopilotTransport);
    expect(copilotTransport.getInitTimeout()).toBe(120_000);
    expect(copilotTransport.getIdleTimeout()).toBe(2_000);
  });
});
