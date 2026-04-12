import * as Clipboard from 'expo-clipboard';
import { Modal } from '@/modal';
import { Session } from '@/sync/storageTypes';
import { t } from '@/text';
import { log } from '@/log';

export async function copySessionMetadataToClipboard(session: Session): Promise<boolean> {
    if (!session.metadata) {
        Modal.alert(t('common.error'), t('sessionInfo.failedToCopyMetadata'));
        return false;
    }

    try {
        const metadata = JSON.stringify(session.metadata, null, 2);
        const logs = log.getLogs();

        const sections = [
            '=== Session Metadata ===',
            metadata,
        ];

        if (logs.length > 0) {
            sections.push(
                '',
                `=== Client Logs (${logs.length} entries) ===`,
                logs.join('\n'),
            );
        }

        await Clipboard.setStringAsync(sections.join('\n'));
        Modal.alert(t('common.success'), t('sessionInfo.metadataCopied'));
        return true;
    } catch {
        Modal.alert(t('common.error'), t('sessionInfo.failedToCopyMetadata'));
        return false;
    }
}
