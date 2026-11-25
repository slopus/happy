import { sessionReadFile, sessionListDirectory, sessionWorkspaceListDirectory, sessionWorkspaceReadFile, sessionWorkspaceWriteFile } from '@/sync/ops';
import type { FileWorkspaceIO } from './controller';
import { t } from '@/text';
export async function readWorkspaceBytes(sessionId: string, path: string, limit = 10 * 1024 * 1024, externalReadOnly = false): Promise<Uint8Array> {
    let response;
    try {
        response = await (externalReadOnly ? sessionReadFile : sessionWorkspaceReadFile)(sessionId, path);
    } catch (error) {
        if (error instanceof Error && (error.name === 'TimeoutError' || error.message === 'operation has timed out' || error.message === 'RPC call timed out')) {
            throw new Error(t('fileWorkspace.readTimeout'));
        }
        throw error;
    }
    if (!response.success || typeof response.content !== 'string') {
        if (/^(ENOENT|ENOTDIR):/.test(response.error ?? '')) {
            throw new Error(t('fileWorkspace.fileNotFound', { path }));
        }
        throw new Error(response.error || t('fileWorkspace.readError'));
    }
    if (response.content.length > Math.ceil(limit / 3) * 4 + 4) throw new Error(t('fileWorkspace.tooLarge'));
    const binary = atob(response.content);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    if (bytes.byteLength > limit) throw new Error(t('fileWorkspace.tooLarge'));
    return bytes;
}
export async function readWorkspaceText(sessionId: string, path: string, externalReadOnly = false): ReturnType<FileWorkspaceIO['read']> {
    let bytes: Uint8Array;
    try {
        bytes = await readWorkspaceBytes(sessionId, path, 2 * 1024 * 1024, externalReadOnly);
    } catch (error) {
        // Current and older CLI sessions report directories differently. Confirm
        // with the existing listing RPC, retaining the original read's scope.
        if (!(error instanceof Error) || !(/^(EISDIR):/.test(error.message) || error.message === 'Not a regular file')) throw error;
        const listing = await (externalReadOnly ? sessionListDirectory : sessionWorkspaceListDirectory)(sessionId, path);
        if (!listing.success || !Array.isArray(listing.entries)) throw new Error(listing.error || t('fileWorkspace.readError'));
        return { content: '', hash: '', directory: listing.entries };
    }
    if (bytes.includes(0)) throw new Error(t('fileWorkspace.binary'));
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))).map(x => x.toString(16).padStart(2, '0')).join('');
    return { content, hash };
}
export async function writeWorkspaceText(sessionId: string, path: string, content: string, expectedHash: string) {
    const bytes = new TextEncoder().encode(content);
    if (bytes.length > 2 * 1024 * 1024) throw new Error(t('fileWorkspace.tooLarge'));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const response = await sessionWorkspaceWriteFile(sessionId, path, btoa(binary), expectedHash);
    if (!response.success || typeof response.hash !== 'string') throw new Error(response.error || t('fileWorkspace.saveError'));
    return { hash: response.hash };
}
