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

    it.each(['1.2.6-beta.0', '1.2.6-beta.1', '1.2.6', '1.3.0'])('defaults Claude to Opus 5.5 on CLI %s', (version) => {
        expect(getCodeAgentDefaults('claude', version).modelMode).toBe('claude-opus-5-5');
        expect(resolveAgentDefaultConfig({}, 'claude', version).modelMode).toBe('claude-opus-5-5');
    });

    // Unlike the auto gate, an unknown version keeps the old model: an Opus 5.5
    // default on a CLI whose bundled Claude Code predates it fails every turn.
    it.each(['1.2.5', '1.2.5-beta.2', '1.2.0', 'not-a-version', undefined, null])(
        'keeps Claude on Opus 5 on CLI %s',
        (version) => {
            expect(getCodeAgentDefaults('claude', version).modelMode).toBe('claude-opus-5');
            expect(resolveAgentDefaultConfig({}, 'claude', version).modelMode).toBe('claude-opus-5');
        },
    );

    it.each(['1.2.5', '1.2.6-beta.0', '1.3.0', undefined])('lets a saved Claude model win on CLI %s', (version) => {
        for (const modelMode of ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']) {
            expect(resolveAgentDefaultConfig({ claude: { modelMode } }, 'claude', version).modelMode).toBe(modelMode);
        }
    });

    it('does not gate other agents\' default models on the CLI version', () => {
        expect(getCodeAgentDefaults('codex', '1.2.0').modelMode).toBe('gpt-5.6-sol');
        expect(getCodeAgentDefaults('agy').modelMode).toBe('Gemini 3.8 Flash');
    });

    it('does not change non-code-agent defaults for an old CLI', () => {
        expect(resolveAgentDefaultConfig({}, 'gemini', '1.0.0').permissionMode).toBe('default');
        expect(resolveAgentDefaultConfig({}, 'openclaw', '1.0.0').permissionMode).toBe('default');
        expect(resolveAgentDefaultConfig({}, 'agy', '1.0.0').permissionMode).toBe('default');
    });
});