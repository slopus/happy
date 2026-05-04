import { describe, expect, it } from 'vitest';

import { createCodexModeState, resolveCodexMessageMode } from './modeState';

describe('resolveCodexMessageMode', () => {
    it('preserves CLI model when app metadata sends model null', () => {
        const state = createCodexModeState({ model: 'gpt-5.5' });

        const resolved = resolveCodexMessageMode(state, { model: null });

        expect(resolved.mode.model).toBe('gpt-5.5');
        expect(resolved.state.currentModel).toBe('gpt-5.5');
    });

    it('preserves CLI yolo when app metadata sends default permission mode', () => {
        const state = createCodexModeState({ permissionMode: 'yolo' });

        const resolved = resolveCodexMessageMode(state, { permissionMode: 'default' });

        expect(resolved.mode.permissionMode).toBe('yolo');
        expect(resolved.state.currentPermissionMode).toBe('yolo');
    });

    it('allows app non-default model to override CLI model and become sticky', () => {
        const state = createCodexModeState({ model: 'gpt-5.5' });

        const first = resolveCodexMessageMode(state, { model: 'gpt-5.4' });
        const second = resolveCodexMessageMode(first.state, { model: null });

        expect(first.mode.model).toBe('gpt-5.4');
        expect(second.mode.model).toBe('gpt-5.4');
    });

    it('allows app non-default permission mode to override CLI permission mode and become sticky', () => {
        const state = createCodexModeState({ permissionMode: 'yolo' });

        const first = resolveCodexMessageMode(state, { permissionMode: 'read-only' });
        const second = resolveCodexMessageMode(first.state, { permissionMode: 'default' });

        expect(first.mode.permissionMode).toBe('read-only');
        expect(second.mode.permissionMode).toBe('read-only');
    });

    it('preserves default and null behavior when no CLI flags are set', () => {
        const state = createCodexModeState({});

        const resolved = resolveCodexMessageMode(state, {
            permissionMode: 'default',
            model: null,
        });

        expect(resolved.mode).toEqual({
            permissionMode: 'default',
            model: undefined,
            effort: undefined,
        });
        expect(resolved.state.currentPermissionMode).toBeUndefined();
        expect(resolved.state.currentModel).toBeUndefined();
    });

    it('carries CLI effort into every resolved mode', () => {
        const state = createCodexModeState({ effort: 'medium' });

        const resolved = resolveCodexMessageMode(state, {});

        expect(resolved.mode.effort).toBe('medium');
    });
});
