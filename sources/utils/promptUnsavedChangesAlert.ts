import type { AlertButton } from '@/modal/types';

export type UnsavedChangesDecision = 'discard' | 'save' | 'keepEditing';

export function promptUnsavedChangesAlert(
    alert: (title: string, message?: string, buttons?: AlertButton[]) => void,
    params: {
        title: string;
        message: string;
        discardText: string;
        saveText: string;
        keepEditingText: string;
    },
): Promise<UnsavedChangesDecision> {
    return new Promise((resolve) => {
        alert(params.title, params.message, [
            {
                text: params.discardText,
                style: 'destructive',
                onPress: () => resolve('discard'),
            },
            {
                text: params.saveText,
                style: 'default',
                onPress: () => resolve('save'),
            },
            {
                text: params.keepEditingText,
                style: 'cancel',
                onPress: () => resolve('keepEditing'),
            },
        ]);
    });
}

