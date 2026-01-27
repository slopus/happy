import { describe, expect, test } from 'vitest';

import { getAgentVendorResumeId } from './resumeCapabilities';

describe('getAgentVendorResumeId', () => {
    test('returns null when metadata missing', () => {
        expect(getAgentVendorResumeId(null, 'claude')).toBeNull();
    });

    test('returns null when agent is not resumable', () => {
        expect(getAgentVendorResumeId({ claudeSessionId: 'c1' }, 'gemini')).toBeNull();
    });

    test('returns Claude session id when agent is claude', () => {
        expect(getAgentVendorResumeId({ claudeSessionId: 'c1' }, 'claude')).toBe('c1');
    });

    test('returns null for experimental resume agents when not enabled', () => {
        expect(getAgentVendorResumeId({ codexSessionId: 'x1' }, 'codex')).toBeNull();
    });

    test('returns Codex session id when experimental resume is enabled for Codex', () => {
        expect(getAgentVendorResumeId({ codexSessionId: 'x1' }, 'codex', { allowExperimentalResumeByAgentId: { codex: true } })).toBe('x1');
    });

    test('treats persisted Codex flavor aliases as Codex for resume', () => {
        expect(getAgentVendorResumeId({ codexSessionId: 'x1' }, 'openai', { allowExperimentalResumeByAgentId: { codex: true } })).toBe('x1');
        expect(getAgentVendorResumeId({ codexSessionId: 'x1' }, 'gpt', { allowExperimentalResumeByAgentId: { codex: true } })).toBe('x1');
    });

    test('returns null for runtime resume agents when not enabled', () => {
        expect(getAgentVendorResumeId({ opencodeSessionId: 'o1' }, 'opencode')).toBeNull();
    });

    test('returns OpenCode session id when runtime resume is enabled for OpenCode', () => {
        expect(getAgentVendorResumeId({ opencodeSessionId: 'o1' }, 'opencode', { allowRuntimeResumeByAgentId: { opencode: true } })).toBe('o1');
    });
});
