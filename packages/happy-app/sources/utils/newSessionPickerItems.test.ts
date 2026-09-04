import { describe, expect, it } from 'vitest';
import { getAgentPickerItems, getModePickerItems } from './newSessionPickerItems';

describe('new session picker items', () => {
    it('maps agents to picker item labels', () => {
        expect(getAgentPickerItems([
            { key: 'claude', label: 'claude code' },
            { key: 'codex', label: 'codex' },
        ])).toEqual([
            { key: 'claude', label: 'claude code' },
            { key: 'codex', label: 'codex' },
        ]);
    });

    it('maps model, effort, and permission options with descriptions', () => {
        expect(getModePickerItems([
            { key: 'default', name: 'default model', description: null },
            { key: 'opus', name: 'opus 4.7', description: 'larger context' },
        ])).toEqual([
            { key: 'default', label: 'default model' },
            { key: 'opus', label: 'opus 4.7', subtitle: 'larger context' },
        ]);
    });

    it('groups provider models in first-seen provider and wire order', () => {
        expect(getModePickerItems([
            { key: 'codex:sol', name: 'Sol', description: 'OpenAI Codex', providerId: 'codex', providerName: 'OpenAI Codex' },
            { key: 'claude:opus', name: 'Opus', description: 'Anthropic Claude', providerId: 'claude', providerName: 'Anthropic Claude' },
            { key: 'codex:terra', name: 'Terra', description: 'OpenAI Codex', providerId: 'codex', providerName: 'OpenAI Codex' },
        ])).toEqual([
            { key: 'codex:sol', label: 'Sol', section: 'OpenAI Codex' },
            { key: 'codex:terra', label: 'Terra', section: 'OpenAI Codex' },
            { key: 'claude:opus', label: 'Opus', section: 'Anthropic Claude' },
        ]);
    });
});
