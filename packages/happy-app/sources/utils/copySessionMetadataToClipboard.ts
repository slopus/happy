import * as Clipboard from 'expo-clipboard';
import { Modal } from '@/modal';
import { Session } from '@/sync/storageTypes';
import { t } from '@/text';

export async function copySessionMetadataToClipboard(session: Session): Promise<boolean> {
    if (!session.metadata) {
        Modal.alert(t('common.error'), t('sessionInfo.failedToCopyMetadata'));
        return false;
    }

    try {
        await Clipboard.setStringAsync(JSON.stringify(session.metadata, null, 2));
        Modal.alert(t('common.success'), t('sessionInfo.metadataCopied'));
        return true;
    } catch {
        Modal.alert(t('common.error'), t('sessionInfo.failedToCopyMetadata'));
        return false;
    }
}
