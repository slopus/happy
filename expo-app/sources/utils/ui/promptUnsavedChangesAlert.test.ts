import { describe, expect, it } from 'vitest';
import type { AlertButton } from '@/modal/types';
import { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';

const basePromptOptions = {
    title: 'Discard changes',
    message: 'You have unsaved changes.',
    discardText: 'Discard',
    saveText: 'Save',
    keepEditingText: 'Keep editing',
} as const;

function createPromptHarness() {
    let lastButtons: AlertButton[] | undefined;

    const alert = (_title: string, _message?: string, buttons?: AlertButton[]) => {
        lastButtons = buttons;
    };

    const promise = promptUnsavedChangesAlert(alert, basePromptOptions);

    function press(text: string) {
        const button = lastButtons?.find((b) => b.text === text);
        expect(button).toBeDefined();
        button?.onPress?.();
    }

    return { promise, press };
}

describe('promptUnsavedChangesAlert', () => {
    it('resolves to save when the Save button is pressed', async () => {
        const { promise, press } = createPromptHarness();

        press('Save');

        await expect(promise).resolves.toBe('save');
    });

    it('resolves to discard when the Discard button is pressed', async () => {
        const { promise, press } = createPromptHarness();

        press('Discard');

        await expect(promise).resolves.toBe('discard');
    });

    it('resolves to keepEditing when the Keep editing button is pressed', async () => {
        const { promise, press } = createPromptHarness();

        press('Keep editing');

        await expect(promise).resolves.toBe('keepEditing');
    });
});
