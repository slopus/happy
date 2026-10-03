import { describe, expect, it } from 'vitest';
import { parseAppChatSelection } from './appChat';
describe('application model allowlist', () => {
    it('keeps old requests on the original model', () => expect(parseAppChatSelection(undefined)).toEqual({ engine: 'codex', model: 'gpt-6-astra' }));
    it.each([{ engine: 'claude', model: 'gpt-6-astra' }, { engine: 'codex', model: '--config' }, { engine: 'claude', model: 'sonnet', tools: 'Bash' }, null])('rejects invalid settings %j', value => expect(() => parseAppChatSelection(value)).toThrow());
    it('accepts explicitly selected Claude and Codex models', () => {
        expect(parseAppChatSelection({ engine: 'claude', model: 'sonnet' }).engine).toBe('claude');
        expect(parseAppChatSelection({ engine: 'codex', model: 'gpt-6-luna' }).model).toBe('gpt-6-luna');
    });
});
