import { describe, expect, it } from 'vitest';
import { resolveNewSessionSpawnSettings } from './newSessionSpawnSettings';

describe('resolveNewSessionSpawnSettings', () => {
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
