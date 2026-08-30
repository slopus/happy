import * as React from 'react';
import * as Clipboard from 'expo-clipboard';
import type { MachineChoice } from '@/sync/machineChoices';
import { useSessions } from '@/sync/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { buildOfflineMachineTroubleshooting } from '@/utils/offlineMachineTroubleshooting';

export function useOfflineMachineTroubleshooting(choices: readonly MachineChoice[]): () => void {
    const sessions = useSessions();
    const guide = React.useMemo(
        () => buildOfflineMachineTroubleshooting(choices, sessions),
        [choices, sessions],
    );

    return React.useCallback(() => {
        Modal.alert('Troubleshoot connection', guide.message, [
            { text: t('common.cancel'), style: 'cancel' },
            {
                text: 'Copy AI prompt',
                onPress: () => {
                    void Clipboard.setStringAsync(guide.aiPrompt).catch(() => {
                        Modal.alert(t('common.error'), 'Could not copy the AI prompt.');
                    });
                },
            },
        ]);
    }, [guide]);
}