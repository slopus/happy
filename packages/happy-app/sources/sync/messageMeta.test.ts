import { describe, expect, it } from 'vitest';
import { resolveMessageModeMeta } from './messageMeta';

describe('resolveMessageModeMeta', () => {
    it('sends explicit permission and model keys', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'read-only',
            modelMode: 'gpt-5-high',
            metadata: null,
        } as any);

        expect(meta).toEqual({
            permissionMode: 'read-only',
            model: 'gpt-5-high',
        });
    });

    it('forces bypass permissions in sandbox when mode is default', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'default',
            modelMode: null,
            metadata: {
                sandbox: { enabled: true },
            },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'bypassPermissions',
            model: null,
        });
    });

    it('keeps default permissions when sandbox is disabled', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: 'default',
            metadata: {
                sandbox: null,
            },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'default',
            model: null,
        });
    });

    it('uses initialPermissionMode from metadata when session mode is default', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'default',
            modelMode: null,
            metadata: {
                sandbox: null,
                initialPermissionMode: 'acceptEdits',
            },
        } as any);

        expect(meta.permissionMode).toBe('acceptEdits');
    });

    it('uses initialPermissionMode bypassPermissions when CLI started with --yolo', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'default',
            modelMode: null,
            metadata: {
                sandbox: null,
                initialPermissionMode: 'bypassPermissions',
            },
        } as any);

        expect(meta.permissionMode).toBe('bypassPermissions');
    });

    it('falls back to dangerouslySkipPermissions for legacy sessions without initialPermissionMode', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'default',
            modelMode: null,
            metadata: {
                sandbox: null,
                dangerouslySkipPermissions: true,
            },
        } as any);

        expect(meta.permissionMode).toBe('bypassPermissions');
    });

    it('ignores unknown initialPermissionMode values (forward-compat)', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'default',
            modelMode: null,
            metadata: {
                sandbox: null,
                initialPermissionMode: 'someFutureMode',
            },
        } as any);

        expect(meta.permissionMode).toBe('default');
    });

    it('respects explicit non-default user choice over initialPermissionMode', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'plan',
            modelMode: null,
            metadata: {
                sandbox: null,
                initialPermissionMode: 'bypassPermissions',
            },
        } as any);

        expect(meta.permissionMode).toBe('plan');
    });

    it('sandbox overrides initialPermissionMode', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'default',
            modelMode: null,
            metadata: {
                sandbox: { enabled: true },
                initialPermissionMode: 'acceptEdits',
            },
        } as any);

        expect(meta.permissionMode).toBe('bypassPermissions');
    });
});
