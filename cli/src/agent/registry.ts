import type { AgentId } from './core';

export type AgentRegistrar = () => void;

export const agentRegistrarById = {
  gemini: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerGeminiAgent } = require('./factories/gemini');
    registerGeminiAgent();
  },
  opencode: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerOpenCodeAgent } = require('./factories/opencode');
    registerOpenCodeAgent();
  },
} satisfies Partial<Record<AgentId, AgentRegistrar>>;

export function registerDefaultAgents(): void {
  agentRegistrarById.gemini?.();
  agentRegistrarById.opencode?.();
}

