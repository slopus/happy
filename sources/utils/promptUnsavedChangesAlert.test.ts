import { describe, expect, it } from 'vitest';
import type { AlertButton } from '@/modal/types';
import { promptUnsavedChangesAlert } from './promptUnsavedChangesAlert';

describe('promptUnsavedChangesAlert', () => {
    it('resolves to save when the Save button is pressed', async () => {
        let lastButtons: AlertButton[] | undefined;

        const alert = (_title: string, _message?: string, buttons?: AlertButton[]) => {
            lastButtons = buttons;
        };

        const promise = promptUnsavedChangesAlert(alert, {
            title: 'Discard changes',
            message: 'You have unsaved changes.',
            discardText: 'Discard',
            saveText: 'Save',
            keepEditingText: 'Keep editing',
        });

        lastButtons?.find((b) => b.text === 'Save')?.onPress?.();

        await expect(promise).resolves.toBe('save');
    });

    it('resolves to discard when the Discard button is pressed', async () => {
        let lastButtons: AlertButton[] | undefined;

        const alert = (_title: string, _message?: string, buttons?: AlertButton[]) => {
            lastButtons = buttons;
        };

        const promise = promptUnsavedChangesAlert(alert, {
            title: 'Discard changes',
            message: 'You have unsaved changes.',
            discardText: 'Discard',
            saveText: 'Save',
            keepEditingText: 'Keep editing',
        });

        lastButtons?.find((b) => b.text === 'Discard')?.onPress?.();

        await expect(promise).resolves.toBe('discard');
    });

    it('resolves to keepEditing when the Keep editing button is pressed', async () => {
        let lastButtons: AlertButton[] | undefined;

        const alert = (_title: string, _message?: string, buttons?: AlertButton[]) => {
            lastButtons = buttons;
        };

        const promise = promptUnsavedChangesAlert(alert, {
            title: 'Discard changes',
            message: 'You have unsaved changes.',
            discardText: 'Discard',
            saveText: 'Save',
            keepEditingText: 'Keep editing',
        });

        lastButtons?.find((b) => b.text === 'Keep editing')?.onPress?.();

        await expect(promise).resolves.toBe('keepEditing');
    });
});
