import { GOAL_ARTIFACT_MAX_TEXT_BYTES, type GoalBoardAttachment } from '@slopus/happy-wire';
import { decryptBlob } from '@/encryption/blob';
import { downloadEncryptedAttachment } from './apiAttachments';
import { sync } from './sync';

/** Resolve exact original UTF-8 bytes through the encrypted HTTP attachment lane. */
export async function loadGoalArtifactText(sessionId: string, attachment: GoalBoardAttachment, signal?: AbortSignal): Promise<string> {
    const current = () => { if (signal?.aborted) { const error = new Error('Artifact request cancelled'); error.name = 'AbortError'; throw error; } };
    current();
    if (attachment.kind !== 'file' || !attachment.encrypted || attachment.size > GOAL_ARTIFACT_MAX_TEXT_BYTES) throw new Error('Invalid text attachment');
    const credentials = sync.getCredentials();
    const key = sync.encryption.getSessionBlobKey(sessionId);
    if (!credentials || !key) throw new Error('Attachment credentials are unavailable');
    const encrypted = await downloadEncryptedAttachment(credentials, sessionId, attachment.ref);
    current();
    const bytes = decryptBlob(encrypted, key);
    if (!bytes) throw new Error('Attachment decryption failed');
    if (bytes.byteLength > GOAL_ARTIFACT_MAX_TEXT_BYTES || bytes.byteLength !== attachment.size) throw new Error('Text attachment size mismatch');
    if (bytes.includes(0)) throw new Error('Binary file cannot be read as text');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
