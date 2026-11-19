import { describe, expect, it } from 'vitest';
import {
    getComposeHomeExperience,
    getRunningSessionInfoExperience,
    getSessionConfigExperience,
} from './newSessionExperience';

describe('new session experience', () => {

    it('keeps coding agents on the full setup surface', () => {
        expect(getSessionConfigExperience('opencode')).toEqual({
            showPath: true,
            showModeDetails: true,
            showPermission: true,
            showWorktree: true,
        });
    });


    it('allows OpenCode image input in the shared home and new-session composer', () => {
        expect(getComposeHomeExperience({
            agentType: 'opencode', activeImageAgent: false, imagePluginInstalled: false,
        }).canAttach).toBe(true);
    });

    it('preserves image-agent routing as a Codex image task', () => {
        expect(getComposeHomeExperience({ agentType: 'codex', activeImageAgent: true, imagePluginInstalled: true })).toEqual({
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




});
