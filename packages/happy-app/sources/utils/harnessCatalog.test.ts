import { describe, expect, it } from 'vitest';

import { HARNESS_NAMES, isRetiredHarness, listAvailableHarnesses } from './harnessCatalog';

describe('harness catalog', () => {
    it('names Happy and Antigravity by product, not by CLI id', () => {
        expect(HARNESS_NAMES.rig).toBe('Happy');
        expect(HARNESS_NAMES.agy).toBe('Antigravity');
    });

    it('retires Gemini and OpenClaw only', () => {
        expect(isRetiredHarness('gemini')).toBe(true);
        expect(isRetiredHarness('openclaw')).toBe(true);
        expect(isRetiredHarness('claude')).toBe(false);
        // Antigravity is what Gemini's own error message redirects people to.
        expect(isRetiredHarness('agy')).toBe(false);
    });

    it('lists only installed harnesses, in pick order', () => {
        const harnesses = listAvailableHarnesses({
            availability: { claude: true, codex: true, agy: true },
            happyAgentAvailable: true,
            selected: 'claude',
        });

        expect(harnesses.map((harness) => harness.key)).toEqual(['claude', 'codex', 'agy', 'rig']);
        expect(harnesses.map((harness) => harness.name)).toEqual([
            'Claude Code',
            'Codex',
            'Antigravity',
            'Happy',
        ]);
    });

    it('never offers a retired harness, even with its CLI installed', () => {
        const harnesses = listAvailableHarnesses({
            availability: { claude: true, gemini: true, openclaw: true },
            happyAgentAvailable: false,
            selected: 'claude',
        });

        expect(harnesses.map((harness) => harness.key)).toEqual(['claude']);
    });

    // The "keep the current selection listed" rule must not apply here, or a
    // stale draft would pin someone to an agent they can no longer start.
    it('does not keep a retired harness listed just because it is selected', () => {
        const harnesses = listAvailableHarnesses({
            availability: { claude: true, gemini: true },
            happyAgentAvailable: false,
            selected: 'gemini',
        });

        expect(harnesses.map((harness) => harness.key)).toEqual(['claude']);
    });

    it('keeps a real name for a retired harness so old sessions still read right', () => {
        expect(HARNESS_NAMES.gemini).toBe('Gemini');
        expect(HARNESS_NAMES.openclaw).toBe('OpenClaw');
    });

    it('drops Happy when no connected machine can run it', () => {
        const harnesses = listAvailableHarnesses({
            availability: { claude: true, codex: true },
            happyAgentAvailable: false,
            selected: 'claude',
        });

        expect(harnesses.map((harness) => harness.key)).toEqual(['claude', 'codex']);
    });

    it('keeps the current selection listed even once its CLI disappears', () => {
        const harnesses = listAvailableHarnesses({
            availability: { claude: false, codex: true },
            happyAgentAvailable: false,
            selected: 'claude',
        });

        expect(harnesses.map((harness) => harness.key)).toEqual(['claude', 'codex']);
    });

    it('never lists Antigravity without an explicit installation report', () => {
        expect(listAvailableHarnesses({
            availability: { claude: true, agy: false },
            happyAgentAvailable: false,
            selected: 'agy',
        }).map((harness) => harness.key)).toEqual(['claude']);

        expect(listAvailableHarnesses({
            availability: null,
            happyAgentAvailable: false,
            selected: 'agy',
        }).map((harness) => harness.key)).toEqual(['claude', 'codex']);
    });

    it('falls back to the whole catalog when a machine reports no capabilities', () => {
        expect(listAvailableHarnesses({
            availability: null,
            happyAgentAvailable: false,
            selected: null,
        }).map((harness) => harness.key)).toEqual(['claude', 'codex']);

        expect(listAvailableHarnesses({
            availability: {},
            happyAgentAvailable: false,
            selected: null,
        }).map((harness) => harness.key)).toEqual(['claude', 'codex', 'rig']);
    });
});
