import { describe, expect, it } from 'vitest';
import {
    getCodingAgentPickerItems,
    getComposeHomeExperience,
    getHeaderModeSwitchExperience,
    getRunningSessionInfoExperience,
    getSessionConfigExperience,
    getTopLevelModeForAgent,
    selectAgentForTopLevelMode,
} from './newSessionExperience';

describe('new session experience', () => {
    it('makes ask a lightweight chat mode with provider model selection', () => {
        expect(getSessionConfigExperience('ask')).toEqual({
            isAskMode: true,
            showPath: false,
            showModeDetails: true,
            showPermission: false,
            showWorktree: false,
        });
    });

    it('keeps coding agents on the full setup surface', () => {
        expect(getSessionConfigExperience('opencode')).toEqual({
            isAskMode: false,
            showPath: true,
            showModeDetails: true,
            showPermission: true,
            showWorktree: true,
        });
    });

    it('hides creation tools from the ask home composer', () => {
        expect(getComposeHomeExperience({ agentType: 'ask', activeImageAgent: false, imagePluginInstalled: true })).toEqual({
            displayAgentType: 'ask',
            canAttach: false,
            showCreationRail: false,
        });
    });

    it('preserves image-agent routing as a Codex image task', () => {
        expect(getComposeHomeExperience({ agentType: 'ask', activeImageAgent: true, imagePluginInstalled: true })).toEqual({
            displayAgentType: 'codex',
            canAttach: true,
            showCreationRail: false,
        });
    });

    it('shows image creation tools only when the generated-images plugin is installed', () => {
        expect(getComposeHomeExperience({
            agentType: 'codex',
            activeImageAgent: false,
            imagePluginInstalled: false,
        }).showCreationRail).toBe(false);
        expect(getComposeHomeExperience({
            agentType: 'codex',
            activeImageAgent: false,
            imagePluginInstalled: true,
        }).showCreationRail).toBe(true);
    });

    it('drives a compact header mode switch outside image-agent flows', () => {
        expect(getHeaderModeSwitchExperience({ agentType: 'ask', activeImageAgent: false, askConfigured: true })).toEqual({
            visible: true,
            selectedMode: 'ask',
        });
        expect(getHeaderModeSwitchExperience({ agentType: 'codex', activeImageAgent: false, askConfigured: true })).toEqual({
            visible: true,
            selectedMode: 'agent',
        });
        expect(getHeaderModeSwitchExperience({ agentType: 'ask', activeImageAgent: false, askConfigured: false })).toEqual({
            visible: false,
            selectedMode: 'agent',
        });
        expect(getHeaderModeSwitchExperience({ agentType: 'ask', activeImageAgent: true, askConfigured: true })).toEqual({
            visible: false,
            selectedMode: 'agent',
        });
    });

    it('treats ask as a top-level mode outside the coding-agent picker', () => {
        expect(getTopLevelModeForAgent('ask')).toBe('ask');
        expect(getTopLevelModeForAgent('codex')).toBe('agent');
        expect(getCodingAgentPickerItems([
            { key: 'ask', label: 'ask' },
            { key: 'opencode', label: 'opencode' },
            { key: 'claude', label: 'claude code' },
        ])).toEqual([
            { key: 'opencode', label: 'opencode' },
            { key: 'claude', label: 'claude code' },
        ]);
    });

    it('switches top-level mode without keeping ask in the agent list', () => {
        expect(selectAgentForTopLevelMode({
            mode: 'ask',
            currentAgent: 'codex',
            availableCodingAgents: [{ key: 'opencode', label: 'opencode' }],
        })).toBe('ask');

        expect(selectAgentForTopLevelMode({
            mode: 'agent',
            currentAgent: 'ask',
            availableCodingAgents: [
                { key: 'opencode', label: 'opencode' },
                { key: 'codex', label: 'codex' },
            ],
        })).toBe('opencode');

        expect(selectAgentForTopLevelMode({
            mode: 'agent',
            currentAgent: 'codex',
            availableCodingAgents: [
                { key: 'opencode', label: 'opencode' },
                { key: 'codex', label: 'codex' },
            ],
        })).toBe('codex');
    });

    it('hides running-session path and permission rows for ask sessions', () => {
        expect(getRunningSessionInfoExperience('ask')).toEqual({
            isAskMode: true,
            showPath: false,
            showModelDetails: true,
            showPermission: false,
        });
        expect(getRunningSessionInfoExperience('codex')).toEqual({
            isAskMode: false,
            showPath: true,
            showModelDetails: true,
            showPermission: true,
        });
    });
});
