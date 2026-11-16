import { describe, expect, it } from 'vitest';
import { resolveNewSessionSpawnSettings } from './newSessionSpawnSettings';
import { resolveMessageModeMeta } from '@/sync/messageMeta';

describe('resolveNewSessionSpawnSettings', () => {
    it('preserves a live default model and its native connection instead of restoring a stale draft', () => {
        expect(resolveNewSessionSpawnSettings({ draftWorktreeKey: null,
            resolvedModes: { modelMode: 'deepseek/DeepSeek-V4.1-Flash' },
            liveSelection: { modelKey: undefined, effortKey: null, worktreeKey: '__none__', fastMode: false,
                expectedCodexAccountProfileId: null } })).toMatchObject({ modelMode: 'default', effortLevel: 'default', expectedCodexAccountProfileId: null });
    });
    it.each([undefined, 'deepseek/DeepSeek-V4.1-Flash'])('keeps the real outbound message on native defaults before or after model hydration (%s)', (currentModelCode) => {
        const launch = resolveNewSessionSpawnSettings({ draftWorktreeKey: null,
            resolvedModes: { modelMode: 'gpt-6.1-sol', effortLevel: 'high' },
            liveSelection: { modelKey: undefined, effortKey: null, worktreeKey: '__none__', fastMode: false } });
        const message = resolveMessageModeMeta({ modelMode: launch.modelMode, effortLevel: launch.effortLevel,
            metadata: { flavor: 'codex', currentModelCode, currentThoughtLevelCode: 'high' } } as any,
            { agentDefaultOverrides: { codex: { modelMode: 'gpt-6-astra', effortLevel: 'xhigh' } } } as any);
        expect(message).toMatchObject({ model: null, effort: null });
    });
    it('uses the live composer selections for every launch setting', () => {
        expect(resolveNewSessionSpawnSettings({
            draftWorktreeKey: null,
            resolvedModes: {
                permissionMode: 'safe-yolo',
                modelMode: 'gpt-5.6-sol',
                effortLevel: 'medium',
            },
            liveSelection: {
                permissionKey: 'yolo',
                modelKey: 'gpt-5.6-terra',
                effortKey: 'high',
                worktreeKey: '/Users/test/happy--feature',
                fastMode: true,
            },
        })).toEqual({
            permissionMode: 'yolo',
            modelMode: 'gpt-5.6-terra',
            effortLevel: 'high',
            worktreeKey: '/Users/test/happy--feature',
            fastMode: true,
        });
    });

    it('falls back to the persisted draft and resolved agent defaults', () => {
        expect(resolveNewSessionSpawnSettings({
            draftWorktreeKey: null,
            resolvedModes: {
                permissionMode: 'read-only',
                modelMode: 'gpt-5.6-sol',
                effortLevel: null,
            },
            liveSelection: null,
        })).toEqual({
            permissionMode: 'read-only',
            modelMode: 'gpt-5.6-sol',
            effortLevel: null,
            worktreeKey: null,
            fastMode: false,
        });
    });
});
