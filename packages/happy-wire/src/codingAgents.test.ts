import { describe, it, expect } from 'vitest';
import { CodingAgentUpdateRequestSchema, CodingAgentsInspectRequestSchema } from './codingAgents';
describe('coding agent management protocol', () => {
  it('defaults to detection without remote update queries', () => {
    expect(CodingAgentsInspectRequestSchema.parse({})).toEqual({ checkUpdates: false });
  });
  it('accepts a single known agent for a row check', () => {
    expect(CodingAgentsInspectRequestSchema.parse({ id: 'claude', checkUpdates: true })).toEqual({ id: 'claude', checkUpdates: true });
    expect(CodingAgentsInspectRequestSchema.safeParse({ id: 'other', checkUpdates: true }).success).toBe(false);
  });
  it('accepts only a known agent and a server-issued token, never executable arguments', () => {
    const valid = { id: 'codex', updateToken: '00000000-0000-4000-8000-000000000001' };
    expect(CodingAgentUpdateRequestSchema.safeParse(valid).success).toBe(true);
    for (const value of [{ ...valid, id: 'codex;curl x' }, { ...valid, command: 'npm install anything' }, { ...valid, updateToken: 'not-issued' }]) {
      expect(CodingAgentUpdateRequestSchema.safeParse(value).success).toBe(false);
    }
  });
});
