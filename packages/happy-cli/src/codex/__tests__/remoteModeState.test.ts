import { describe, expect, it } from 'vitest';

import { CodexRemoteModeState } from '../remoteModeState';

describe('CodexRemoteModeState', () => {
    it('uses the exact launch permission, model, and effort before any app override', () => {
        const state = new CodexRemoteModeState({
            permissionMode: 'safe-yolo',
            model: 'gpt-5.6-sol',
            effort: 'medium',
        });

        expect(state.resolve(undefined)).toMatchObject({
            permissionMode: 'safe-yolo',
            model: 'gpt-5.6-sol',
            effort: 'medium',
            permission: { kind: 'retained' },
            modelResolution: { kind: 'retained' },
            effortResolution: { kind: 'retained' },
        });
    });

    it('applies permission, model, and effort switches together mid-session', () => {
        const state = new CodexRemoteModeState({
            permissionMode: 'safe-yolo',
            model: 'gpt-5.6-sol',
            effort: 'medium',
        });

        expect(state.resolve({
            permissionMode: 'auto',
            model: 'gpt-5.6-terra',
            effort: 'max',
        })).toMatchObject({
            permissionMode: 'auto',
            model: 'gpt-5.6-terra',
            effort: 'max',
            permission: { kind: 'updated' },
            modelResolution: { kind: 'updated' },
            effortResolution: { kind: 'updated' },
        });
        expect(state.currentPermissionModeExplicitlySet).toBe(true);
    });

    it('keeps model and effort sticky during the abort safety reset', () => {
        const state = new CodexRemoteModeState({
            permissionMode: 'safe-yolo',
            model: 'gpt-5.6-sol',
            effort: 'medium',
        });
        state.resolve({
            permissionMode: 'yolo',
            model: 'gpt-5.6-luna',
            effort: 'high',
        });

        state.resetAfterAbort();

        expect(state.currentPermissionMode).toBe('safe-yolo');
        expect(state.currentPermissionModeExplicitlySet).toBe(false);
        expect(state.currentModel).toBe('gpt-5.6-luna');
        expect(state.currentEffort).toBe('high');
    });

    it('restores all app-selected values on the first message after abort', () => {
        const state = new CodexRemoteModeState({
            permissionMode: 'safe-yolo',
            model: 'gpt-5.6-sol',
            effort: 'medium',
        });
        const stickySelection = {
            permissionMode: 'yolo' as const,
            model: 'gpt-5.6-terra',
            effort: 'max',
        };
        state.resolve(stickySelection);
        state.resetAfterAbort();

        expect(state.resolve(stickySelection)).toMatchObject({
            permissionMode: 'yolo',
            model: 'gpt-5.6-terra',
            effort: 'max',
        });
        expect(state.currentPermissionModeExplicitlySet).toBe(true);
    });

    it('resets explicit null model and effort without changing permission', () => {
        const state = new CodexRemoteModeState({
            permissionMode: 'auto',
            model: 'gpt-5.6-sol',
            effort: 'medium',
        });

        expect(state.resolve({ model: null, effort: null })).toMatchObject({
            permissionMode: 'auto',
            model: undefined,
            effort: undefined,
        });
    });

    it('rejects invalid remote values without poisoning sticky state', () => {
        const state = new CodexRemoteModeState({
            permissionMode: 'yolo',
            model: 'gpt-5.6-sol',
            effort: 'medium',
        });

        expect(state.resolve({
            permissionMode: 'plan',
            model: 'gpt-5.6-luna',
            effort: 'impossible',
        })).toMatchObject({
            permissionMode: 'yolo',
            model: 'gpt-5.6-luna',
            effort: 'medium',
            permission: { kind: 'ignored', incoming: 'plan' },
            effortResolution: { kind: 'ignored', incoming: 'impossible' },
        });
    });
});