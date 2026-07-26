import { describe, expect, it } from 'vitest';
import {
    agentKeys,
    getAgentDefaultOverride,
    getCodeAgentDefaults,
    normalizeAgentKey,
    resolveAgentDefaultConfig,
    setAgentDefaultOverride,
} from './agentDefaults';

// `resolveSessionFlavor()` in happy-cli (src/agent/acp/runAcp.ts) can emit exactly these three
// values for an ACP-launched session. 'gemini' has a row in `agentKeys`; the other two do not.
const ACP_SESSION_FLAVORS = ['gemini', 'opencode', 'acp'] as const;
const FLAVORS_WITHOUT_PROFILE = ['opencode', 'acp'] as const;

describe('agentDefaults', () => {
    it('keeps agents that have a static profile resolving to their own row', () => {
        for (const key of agentKeys) {
            expect(getCodeAgentDefaults(key)).toBe(getCodeAgentDefaults(key));
            expect(normalizeAgentKey(key)).toBe(key);
        }
        // Distinct agents must not share a defaults row, otherwise a collapse would go unnoticed.
        expect(getCodeAgentDefaults('codex')).not.toEqual(getCodeAgentDefaults('claude'));
    });

    it('does not hand Claude Code defaults to flavors with no static profile', () => {
        for (const flavor of FLAVORS_WITHOUT_PROFILE) {
            expect(getCodeAgentDefaults(flavor)).not.toEqual(getCodeAgentDefaults('claude'));
        }
    });

    it('gives flavors with no static profile neutral defaults', () => {
        for (const flavor of FLAVORS_WITHOUT_PROFILE) {
            const defaults = getCodeAgentDefaults(flavor);
            expect(defaults.permissionMode).toBe('default');
            expect(defaults.modelMode).toBe('default');
            expect(defaults.effortLevel).toBeNull();
        }
    });

    it('covers every flavor an ACP session can report', () => {
        for (const flavor of ACP_SESSION_FLAVORS) {
            const defaults = getCodeAgentDefaults(flavor);
            const hasOwnProfile = (agentKeys as readonly string[]).includes(flavor);
            if (hasOwnProfile) {
                continue;
            }
            expect(defaults).not.toEqual(getCodeAgentDefaults('claude'));
        }
    });

    it('does not read the claude override slot for flavors with no static profile', () => {
        const overrides = { claude: { modelMode: 'sonnet' } };
        expect(getAgentDefaultOverride(overrides, 'claude')).toEqual({ modelMode: 'sonnet' });
        for (const flavor of FLAVORS_WITHOUT_PROFILE) {
            expect(getAgentDefaultOverride(overrides, flavor)).toEqual({});
            expect(resolveAgentDefaultConfig(overrides, flavor).modelMode).not.toBe('sonnet');
        }
    });

    it('does not write into the claude override slot for flavors with no static profile', () => {
        for (const flavor of FLAVORS_WITHOUT_PROFILE) {
            const next = setAgentDefaultOverride({}, flavor, 'modelMode', 'something');
            expect(next).toEqual({});
        }
        // An existing override must survive an unmatched-flavor write untouched.
        const existing = { claude: { modelMode: 'sonnet' } };
        expect(setAgentDefaultOverride(existing, 'acp', 'modelMode', 'something')).toEqual(existing);
    });

    it('still writes and clears overrides for agents that have a profile', () => {
        const written = setAgentDefaultOverride({}, 'codex', 'modelMode', 'something');
        expect(written.codex).toEqual({ modelMode: 'something' });
        expect(setAgentDefaultOverride(written, 'codex', 'modelMode', null)).toEqual({});
    });

    it('leaves normalizeAgentKey falling back to claude for unknown input', () => {
        // Kept for callers that need a concrete key. The defaults lookups deliberately do not
        // use this fallback any more.
        expect(normalizeAgentKey('acp')).toBe('claude');
        expect(normalizeAgentKey(null)).toBe('claude');
        expect(normalizeAgentKey(undefined)).toBe('claude');
        expect(normalizeAgentKey('')).toBe('claude');
    });
});
