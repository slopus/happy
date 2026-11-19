import { afterEach, expect, it, vi } from 'vitest';
import { Session } from './session';
vi.useFakeTimers();
let session: Session;
afterEach(() => { session?.cleanup(); vi.clearAllTimers(); });
it('persists thinking transitions before any assistant/protocol output without rewriting turn outcomes', () => {
 let state: any = { turnStatus: { status: 'completed', updatedAt: 1 }, requests: {} };
 const client = { keepAlive: vi.fn(), updateAgentState: vi.fn(async (update: any) => { state = update(state); }) };
 session = new Session({ api: {} as any, client: client as any, path: '/work', logPath: '/log', sessionId: 'native', messageQueue: {} as any, onModeChange: vi.fn(), mcpServers: {}, hookSettingsPath: '/settings' });
 expect(state.claudeThinking).toBe(false);
 session.onThinkingChange(true);
 expect(state.claudeThinking).toBe(true); expect(state.turnStatus.status).toBe('completed');
 session.onThinkingChange(false); expect(state.claudeThinking).toBe(false);
 expect(client.updateAgentState).toHaveBeenCalledTimes(3);
});
