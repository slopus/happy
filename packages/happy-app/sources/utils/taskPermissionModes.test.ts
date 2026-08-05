import { describe, expect, it } from 'vitest';
import {
    getAgentPermissionModeForTaskLevel,
    getTaskPermissionLevelForAgentMode,
    resolveTaskPermissionAgent,
} from './taskPermissionModes';

describe('task permission mode adapter', () => {
    it.each([
        { flavor: 'claude', confirm: 'default', full: 'bypassPermissions' },
        { flavor: 'codex', confirm: 'acceptEdits', full: 'yolo' },
        { flavor: 'gemini', confirm: 'default', full: 'yolo' },
    ])('maps friendly levels to real $flavor modes', ({ flavor, confirm, full }) => {
        expect(getAgentPermissionModeForTaskLevel(flavor, 'confirm')).toBe(confirm);
        expect(getAgentPermissionModeForTaskLevel(flavor, 'full-access')).toBe(full);
        expect(getTaskPermissionLevelForAgentMode(flavor, confirm)).toBe('confirm');
        expect(getTaskPermissionLevelForAgentMode(flavor, full)).toBe('full-access');
    });

    it('supports legacy Claude and Codex flavor aliases', () => {
        expect(resolveTaskPermissionAgent(undefined)).toBe('claude');
        expect(resolveTaskPermissionAgent('openai')).toBe('codex');
        expect(resolveTaskPermissionAgent('gpt')).toBe('codex');
    });

    it.each(['ask', 'opencode', 'openclaw', 'claude-acp', 'custom-agent'])(
        'does not promise two reliable levels for %s',
        (flavor) => {
            expect(resolveTaskPermissionAgent(flavor)).toBeNull();
            expect(getAgentPermissionModeForTaskLevel(flavor, 'confirm')).toBeNull();
            expect(getTaskPermissionLevelForAgentMode(flavor, 'yolo')).toBeNull();
        },
    );

    it('never overstates non-bypass historical modes as full access', () => {
        expect(getTaskPermissionLevelForAgentMode('codex', 'read-only')).toBe('confirm');
        expect(getTaskPermissionLevelForAgentMode('codex', 'safe-yolo')).toBe('confirm');
        expect(getTaskPermissionLevelForAgentMode('claude', 'plan')).toBe('confirm');
        expect(getTaskPermissionLevelForAgentMode('claude', 'acceptEdits')).toBe('confirm');
    });
});
