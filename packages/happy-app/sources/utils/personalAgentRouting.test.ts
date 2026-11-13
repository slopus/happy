import { describe, expect, it } from 'vitest';
import { AgentDefaultOverridesSchema, getCodeAgentDefaults, resolveAgentDefaultConfig } from '@/sync/agentDefaults';
import { getHardcodedModelModes, getHardcodedPermissionModes, getSupportsWorktree } from '@/components/modelModeOptions';
import { getCodingAgentPickerItems, getSessionConfigExperience } from './newSessionExperience';
import { getAgentPermissionModeForTaskLevel } from './taskPermissionModes';

describe('Paws Personal engine selection', () => {
    it('remains an independent provider through settings and task permissions', () => {
        const saved = AgentDefaultOverridesSchema.parse({ personal: { modelMode: 'my-provider/model' } });
        expect(resolveAgentDefaultConfig(saved, 'personal').modelMode).toBe('my-provider/model');
        expect(getCodeAgentDefaults('personal')).toEqual({ permissionMode: 'default', modelMode: 'default', effortLevel: null });
        expect(getAgentPermissionModeForTaskLevel('personal', 'confirm')).toBe('default');
        expect(getAgentPermissionModeForTaskLevel('personal', 'full-access')).toBe('yolo');
    });
    it('exposes its own native engine without Codex models or unsupported worktrees', () => {
        expect(getCodingAgentPickerItems([{ key: 'personal', label: 'Paws Personal' }, { key: 'ask', label: 'Ask' }]))
            .toEqual([]);
        expect(getSessionConfigExperience('personal')).toMatchObject({ showPath: true, showPermission: true, showWorktree: false });
        expect(getHardcodedModelModes('personal', key => key).map(model => model.key)).toEqual(['default']);
        expect(getHardcodedPermissionModes('personal', key => key).map(mode => mode.key)).toEqual(['default', 'read-only', 'yolo']);
        expect(getSupportsWorktree('personal')).toBe(false);
    });
});
