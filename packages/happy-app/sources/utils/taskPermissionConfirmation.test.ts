import { describe, expect, it, vi } from 'vitest';
import {
    applyTaskPermissionSelection,
    createTaskPermissionConfirmationStore,
} from './taskPermissionConfirmation';

describe('full-access confirmation gate', () => {
    it('does not prompt for the confirmation tier', async () => {
        const confirmFullAccess = vi.fn(async () => false);
        const apply = vi.fn();

        const changed = await applyTaskPermissionSelection({
            sessionId: 'session-a',
            level: 'confirm',
            store: createTaskPermissionConfirmationStore(),
            confirmFullAccess,
            apply,
        });

        expect(changed).toBe(true);
        expect(confirmFullAccess).not.toHaveBeenCalled();
        expect(apply).toHaveBeenCalledOnce();
    });

    it('cancels the first full-access switch without applying it', async () => {
        const apply = vi.fn();

        const changed = await applyTaskPermissionSelection({
            sessionId: 'session-a',
            level: 'full-access',
            store: createTaskPermissionConfirmationStore(),
            confirmFullAccess: vi.fn(async () => false),
            apply,
        });

        expect(changed).toBe(false);
        expect(apply).not.toHaveBeenCalled();
    });

    it('prompts only once per session after a confirmed full-access switch', async () => {
        const store = createTaskPermissionConfirmationStore();
        const confirmFullAccess = vi.fn(async () => true);
        const apply = vi.fn();
        const options = {
            sessionId: 'session-a',
            level: 'full-access' as const,
            store,
            confirmFullAccess,
            apply,
        };

        expect(await applyTaskPermissionSelection(options)).toBe(true);
        expect(await applyTaskPermissionSelection(options)).toBe(true);

        expect(confirmFullAccess).toHaveBeenCalledOnce();
        expect(apply).toHaveBeenCalledTimes(2);
    });

    it('keeps confirmations isolated between sessions', async () => {
        const store = createTaskPermissionConfirmationStore();
        const confirmFullAccess = vi.fn(async () => true);

        for (const sessionId of ['session-a', 'session-b']) {
            await applyTaskPermissionSelection({
                sessionId,
                level: 'full-access',
                store,
                confirmFullAccess,
                apply: vi.fn(),
            });
        }

        expect(confirmFullAccess).toHaveBeenCalledTimes(2);
    });
});
