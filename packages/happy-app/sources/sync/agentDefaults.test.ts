import { describe, expect, it } from 'vitest';
import {
    getCodeAgentDefaults,
    resolveAgentDefaultConfig,
} from './agentDefaults';

describe('agent defaults', () => {
    it('uses Auto as the code default for Claude and Codex', () => {
        expect(getCodeAgentDefaults('claude').permissionMode).toBe('auto');
        expect(getCodeAgentDefaults('codex').permissionMode).toBe('auto');
    });

    it.each(['claude', 'codex'] as const)('falls back to Default for %s on an old CLI', (flavor) => {
        expect(getCodeAgentDefaults(flavor, '1.2.0').permissionMode).toBe('default');
        expect(resolveAgentDefaultConfig({}, flavor, '1.2.1-beta.1').permissionMode).toBe('default');
        expect(resolveAgentDefaultConfig({}, flavor, '1.2.0').permissionMode).toBe('default');
        expect(resolveAgentDefaultConfig({}, flavor, 'not-a-version').permissionMode).toBe('default');
    });

    it.each(['claude', 'codex'] as const)('keeps Auto for %s on a new or unknown-version CLI', (flavor) => {
        expect(resolveAgentDefaultConfig({}, flavor, '1.2.1-beta.2').permissionMode).toBe('auto');
        expect(resolveAgentDefaultConfig({}, flavor, '1.3.0').permissionMode).toBe('auto');
        expect(resolveAgentDefaultConfig({}, flavor).permissionMode).toBe('auto');
    });

    it('does not rewrite an explicit YOLO override for an old CLI', () => {
        expect(resolveAgentDefaultConfig(
            { claude: { permissionMode: 'bypassPermissions' } },
            'claude',
            '1.2.0',
        ).permissionMode).toBe('bypassPermissions');
        expect(resolveAgentDefaultConfig(
            { codex: { permissionMode: 'yolo' } },
            'codex',
            '1.2.0',
        ).permissionMode).toBe('yolo');
    });

    it('leaves an explicit unsupported Auto override available for the send path to reject', () => {
        expect(resolveAgentDefaultConfig(
            { claude: { permissionMode: 'auto' } },
            'claude',
            '1.2.0',
        ).permissionMode).toBe('auto');
    });

    it('does not change non-code-agent defaults for an old CLI', () => {
        expect(resolveAgentDefaultConfig({}, 'gemini', '1.0.0').permissionMode).toBe('default');
        expect(resolveAgentDefaultConfig({}, 'openclaw', '1.0.0').permissionMode).toBe('default');
        expect(resolveAgentDefaultConfig({}, 'agy', '1.0.0').permissionMode).toBe('default');
    });
});