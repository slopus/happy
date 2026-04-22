import { describe, expect, it } from 'vitest';
import { collectSessionValueMap, resolveSessionLocalState } from './sessionLocalState';

describe('sessionLocalState', () => {
    it('preserves existing local model and effort when applying server sessions', () => {
        const localState = resolveSessionLocalState({
            session: {
                draft: null,
                permissionMode: null,
                modelMode: null,
                effortLevel: null,
                metadata: { sandbox: null },
            } as any,
            existingSession: {
                draft: 'draft text',
                permissionMode: 'read-only',
                modelMode: 'gpt-5.4',
                effortLevel: 'medium',
                metadata: { sandbox: null },
            } as any,
        });

        expect(localState).toEqual({
            draft: 'draft text',
            permissionMode: 'read-only',
            modelMode: 'gpt-5.4',
            effortLevel: 'medium',
        });
    });

    it('restores saved local model and effort on initial load', () => {
        const localState = resolveSessionLocalState({
            session: {
                draft: null,
                permissionMode: null,
                modelMode: null,
                effortLevel: null,
                metadata: { sandbox: null },
            } as any,
            savedModelMode: 'gpt-5.3-codex',
            savedEffortLevel: 'low',
        });

        expect(localState).toEqual({
            draft: null,
            permissionMode: 'default',
            modelMode: 'gpt-5.3-codex',
            effortLevel: 'low',
        });
    });

    it('collects persisted session values while dropping default model and mode', () => {
        const map = collectSessionValueMap({
            a: { permissionMode: 'default', modelMode: 'default', effortLevel: 'xhigh' },
            b: { permissionMode: 'read-only', modelMode: 'gpt-5.4', effortLevel: null },
        } as any, 'permissionMode');
        const modelMap = collectSessionValueMap({
            a: { permissionMode: 'default', modelMode: 'default', effortLevel: 'xhigh' },
            b: { permissionMode: 'read-only', modelMode: 'gpt-5.4', effortLevel: null },
        } as any, 'modelMode');
        const effortMap = collectSessionValueMap({
            a: { permissionMode: 'default', modelMode: 'default', effortLevel: 'xhigh' },
            b: { permissionMode: 'read-only', modelMode: 'gpt-5.4', effortLevel: null },
        } as any, 'effortLevel');

        expect(map).toEqual({ b: 'read-only' });
        expect(modelMap).toEqual({ b: 'gpt-5.4' });
        expect(effortMap).toEqual({ a: 'xhigh' });
    });
});
