import { describe, it, expect } from 'vitest';

import { resolveAgentIdOrDefault, resolveAgentIdForPermissionUi } from './resolve';

describe('agents/resolve', () => {
    it('falls back to a default agent id for unknown flavors', () => {
        expect(resolveAgentIdOrDefault('unknown', 'claude')).toBe('claude');
        expect(resolveAgentIdOrDefault(null, 'claude')).toBe('claude');
    });

    it('prefers Codex tool prefix hints for permission UI', () => {
        // When metadata flavor is present, prefer it (tool names can be provider-prefixed inconsistently).
        expect(resolveAgentIdForPermissionUi({ flavor: 'claude', toolName: 'CodexBash' })).toBe('claude');
        expect(resolveAgentIdForPermissionUi({ flavor: 'gemini', toolName: 'CodexBash' })).toBe('gemini');
        expect(resolveAgentIdForPermissionUi({ flavor: null, toolName: 'CodexBash' })).toBe('codex');
    });
});
