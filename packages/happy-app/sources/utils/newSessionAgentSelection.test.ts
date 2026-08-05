import { describe, expect, it } from 'vitest';

import { resolveMachineAgent } from './newSessionAgentSelection';

describe('resolveMachineAgent', () => {
    it('replaces a stale Claude draft with the installed Codex CLI', () => {
        expect(resolveMachineAgent('claude', {
            claude: false,
            codex: true,
            openclaw: false,
            gemini: false,
        })).toBe('codex');
    });

    it('keeps an installed selection', () => {
        expect(resolveMachineAgent('codex', {
            claude: true,
            codex: true,
        })).toBe('codex');
    });

    it('selects Rig on a Rig-only machine', () => {
        expect(resolveMachineAgent('claude', {
            rig: true,
            claude: false,
            codex: false,
        })).toBe('rig');
    });

    it('keeps the persisted selection when capability metadata is missing', () => {
        expect(resolveMachineAgent('claude', undefined)).toBe('claude');
    });

    it('keeps the persisted selection when no CLI is reported', () => {
        expect(resolveMachineAgent('claude', {
            claude: false,
            codex: false,
            openclaw: false,
            gemini: false,
        })).toBe('claude');
    });
});
