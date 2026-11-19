import { describe, expect, it } from 'vitest';
import { getCrossAgentTarget } from './crossAgentContinuation';
const session: any = { id: 'source', active: true, presence: 'online', metadata: { machineId: 'm', path: '/work', flavor: 'claude', claudeSessionId: 'native' } };
const machine: any = { id: 'm', active: true, activeAt: Date.now(), metadata: { crossAgentContinuation: 1, cliAvailability: { codex: true, claude: true } } };
describe('cross-agent action eligibility', () => {
 it('offers the opposite supported agent without requiring the fork experiment', () => {
  expect(getCrossAgentTarget(session, machine)).toBe('codex');
  expect(getCrossAgentTarget({ ...session, metadata: { ...session.metadata, flavor: 'codex', codexThreadId: 'thread' } }, machine)).toBe('claude');
 });
 it('hides unsupported, application-bound, busy, offline and older-daemon sessions', () => {
  expect(getCrossAgentTarget(session, { ...machine, metadata: {} })).toBe(null);
  expect(getCrossAgentTarget(session, { ...machine, active: false, activeAt: 0 })).toBe(null);
  expect(getCrossAgentTarget({ ...session, thinking: true }, machine)).toBe(null);
  expect(getCrossAgentTarget({ ...session, thinking: false, agentState: { claudeThinking: true } }, machine)).toBe(null);
  expect(getCrossAgentTarget({ ...session, presence: 0, thinking: true, agentState: { claudeThinking: true, turnStatus: { status: 'running' } } }, machine)).toBe('codex');
  expect(getCrossAgentTarget({ ...session, agentState: { requests: { req: {} } } }, machine)).toBe(null);
  expect(getCrossAgentTarget({ ...session, metadata: { ...session.metadata, application: { appId: 'app' } } }, machine)).toBe(null);
  expect(getCrossAgentTarget({ ...session, metadata: { ...session.metadata, flavor: 'opencode' } }, machine)).toBe(null);
  expect(getCrossAgentTarget(session, { ...machine, metadata: { ...machine.metadata, cliAvailability: { codex: false } } })).toBe(null);
 });
});
