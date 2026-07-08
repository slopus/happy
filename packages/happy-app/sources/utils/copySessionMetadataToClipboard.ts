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
        await Clipboard.setStringAsync(JSON.stringify(session.metadata, null, 2));
        Modal.alert(t('common.success'), t('sessionInfo.metadataCopied'));
        return true;
    } catch {
        Modal.alert(t('common.error'), t('sessionInfo.failedToCopyMetadata'));
        return false;
    }
}

export async function copySessionIdToClipboard(session: Session): Promise<boolean> {
    try {
        await Clipboard.setStringAsync(session.id);
        Modal.alert(t('common.success'), t('sessionInfo.happySessionIdCopied'));
        return true;
    } catch {
        Modal.alert(t('common.error'), t('sessionInfo.failedToCopySessionId'));
        return false;
    }
}

/**
 * Copies the underlying agent's own session id (Claude Code session id, or the
 * Codex thread id for Codex sessions) — the "original" id as opposed to Happy's
 * own session id. Returns false (no-op) when the session has no backend id yet.
 */
export async function copyOriginalSessionIdToClipboard(session: Session): Promise<boolean> {
    const claudeSessionId = session.metadata?.claudeSessionId;
    const codexThreadId = session.metadata?.codexThreadId;
    const originalId = claudeSessionId ?? codexThreadId;
    if (!originalId) {
        return false;
    }
    const successMessage = claudeSessionId
        ? t('sessionInfo.claudeCodeSessionIdCopied')
        : t('sessionInfo.codexThreadIdCopied');
    const failureMessage = claudeSessionId
        ? t('sessionInfo.failedToCopyClaudeCodeSessionId')
        : t('sessionInfo.failedToCopyCodexThreadId');
    try {
        await Clipboard.setStringAsync(originalId);
        Modal.alert(t('common.success'), successMessage);
        return true;
    } catch {
        Modal.alert(t('common.error'), failureMessage);
        return false;
    }
}

export async function copySessionMetadataAndLogsToClipboard(session: Session): Promise<boolean> {
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
