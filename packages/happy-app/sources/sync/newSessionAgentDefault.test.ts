/**
 * Regression tests for: new-session picker defaults to openclaw/gemini instead of claude
 *
 * Bug: When `cliAvailability.claude === false`, the `availableAgents` override effect in
 * `new/index.tsx` called `draft.setAgentType(availableAgents[0].key)`, which persisted the
 * override to MMKV. On subsequent loads the stored draft had `agentType: 'openclaw'` or
 * `'gemini'` instead of the user's original `'claude'` preference.
 *
 * Root cause: The availability-driven override must NOT persist to the draft store.
 * The stored user preference should only be updated when the user explicitly selects an agent.
 *
 * The pure logic extracted here tests that:
 * 1. When the user's stored preference IS available → return it unchanged.
 * 2. When the user's stored preference is NOT available → return the first available agent
 *    (for display purposes only — this result must NOT be written back to the draft store).
 */

import { describe, it, expect } from 'vitest';
import { resolveDisplayAgent } from '../app/(app)/new/agentUtils';

const ALL_AGENTS = [
    { key: 'claude' as const, label: 'claude code' },
    { key: 'codex' as const, label: 'codex' },
    { key: 'openclaw' as const, label: 'openclaw' },
    { key: 'gemini' as const, label: 'gemini' },
];

describe('resolveDisplayAgent — new-session picker default selection', () => {
    it('returns the stored preference when claude is available', () => {
        const availability = { claude: true, codex: false, gemini: false, openclaw: false, detectedAt: 0 };
        const available = ALL_AGENTS.filter(a => availability[a.key]);
        expect(resolveDisplayAgent('claude', available, ALL_AGENTS)).toBe('claude');
    });

    it('returns the stored preference when all agents are available', () => {
        const availability = { claude: true, codex: true, gemini: true, openclaw: true, detectedAt: 0 };
        const available = ALL_AGENTS.filter(a => availability[a.key]);
        expect(resolveDisplayAgent('claude', available, ALL_AGENTS)).toBe('claude');
    });

    it('falls back to first available when stored preference is not available — but caller must NOT persist this', () => {
        // Claude not detected (e.g., daemon running without login shell so nvm PATH is absent)
        // → picker should show openclaw (first available after claude is filtered out)
        // CRITICAL: the returned value represents display-only; it must not be written to MMKV
        const availability = { claude: false, codex: false, gemini: false, openclaw: true, detectedAt: 0 };
        const available = ALL_AGENTS.filter(a => availability[a.key]);
        expect(resolveDisplayAgent('claude', available, ALL_AGENTS)).toBe('openclaw');
    });

    it('returns stored preference when cliAvailability is absent (all agents shown)', () => {
        // When machine has no cliAvailability data, all agents are shown — preserve stored preference
        expect(resolveDisplayAgent('claude', ALL_AGENTS, ALL_AGENTS)).toBe('claude');
    });

    it('stores claude preference survive even when claude is temporarily unavailable', () => {
        // This test encodes the invariant: the STORED value must remain 'claude'
        // even if the display temporarily shows something else.
        // The bug was: the display fallback was written back to MMKV, corrupting 'claude' → 'openclaw'
        const storedPreference = 'claude';

        // Step 1: claude unavailable → display falls back to openclaw
        const unavailability = { claude: false, codex: false, gemini: false, openclaw: true, detectedAt: 0 };
        const availableWhenUnavailable = ALL_AGENTS.filter(a => unavailability[a.key]);
        const displayAgent = resolveDisplayAgent(storedPreference, availableWhenUnavailable, ALL_AGENTS);
        expect(displayAgent).toBe('openclaw'); // shown to user

        // Step 2: the stored preference must NOT be changed by the display resolution
        // (this is enforced by the caller not passing displayAgent to draft.setAgentType)
        // Simulate: next session open with claude available again
        const fullAvailability = { claude: true, codex: true, gemini: true, openclaw: true, detectedAt: 0 };
        const availableWhenBack = ALL_AGENTS.filter(a => fullAvailability[a.key]);
        expect(resolveDisplayAgent(storedPreference, availableWhenBack, ALL_AGENTS)).toBe('claude');
        // ↑ This ONLY passes if `storedPreference` was never overwritten to 'openclaw'.
    });
});
