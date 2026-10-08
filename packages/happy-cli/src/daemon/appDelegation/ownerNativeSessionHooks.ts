/** Owner-process bridge to the SDK's durable native-session APIs.
 * The lifecycle callback retains daemon policy and account selection. Keys stay
 * in this process and are restricted to the machine and its known sessions.
 */
import { PawsAgentClient, type TrustedRecordKeyCredentials } from '@wangjs-jacky/paws-agent';
import { downloadAttachment } from '@/api/attachmentDownload';
import { decryptBlob } from '@/api/encryption';
import { deriveKey } from '@/utils/deriveKey';
import { detectCodexImage } from '@/codex/codexImageInput';
import type { Credentials } from '@/persistence';
import type { NativeSessionHooks } from './nativeSessionRuntime';

export type OwnerSessionEncryption = {
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
};

export function createOwnerNativeSessionHooks(input: {
    serverUrl: string;
    credentials: Credentials;
    machine: OwnerSessionEncryption & { id: string };
    resolveSessionEncryption: (sessionId: string) => OwnerSessionEncryption | null;
    start: NativeSessionHooks['start'];
}): NativeSessionHooks & { dispose(): Promise<void> } {
    // Even legacy credentials use the resolver scope: an owner-wide secret
    // must not turn this daemon bridge into access to another machine's sessions.
    const credentials: TrustedRecordKeyCredentials = {
        token: input.credentials.token,
        resolveRecordKey(record) {
            const encryption = record.type === 'machine'
                ? record.id === input.machine.id ? input.machine : null
                : input.resolveSessionEncryption(record.id);
            return encryption ? { key: encryption.encryptionKey, variant: encryption.encryptionVariant } : null;
        },
    };
    const client = new PawsAgentClient({
        serverUrl: input.serverUrl,
        credentials: { getCredentials: async () => credentials },
        maxImagesPerMessage: 12,
    });
    return {
        connect: () => client.connect(),
        get: sessionId => client.sessions.get(sessionId),
        historyPage: (sessionId, options) => client.messages.historyPage(sessionId, options),
        watch: (sessionId, options) => client.messages.watch(sessionId, options),
        send: message => client.messages.send(message),
        async readImage(sessionId, ref, mimeType) {
            const prefix = `sessions/${sessionId}/attachments/`;
            const file = ref.startsWith(prefix) ? ref.slice(prefix.length) : '';
            if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)
                || !file || !/^[A-Za-z0-9_.-]+\.enc$/.test(file) || file.includes('..')) throw new Error('invalid-request');
            const session = await client.sessions.get(sessionId);
            const metadata = session.metadata as { machineId?: unknown; application?: { appId?: unknown; bindingId?: unknown } } | null;
            if (metadata?.machineId !== input.machine.id || typeof metadata.application?.appId !== 'string'
                || typeof metadata.application.bindingId !== 'string') throw new Error('permission-denied');
            const encryption = input.resolveSessionEncryption(sessionId);
            if (!encryption) throw new Error('permission-denied');
            const key = await deriveKey(encryption.encryptionKey, 'Happy Blobs', [encryption.encryptionVariant === 'legacy' ? 'master' : 'session']);
            const maxImageBytes = 10 * 1024 * 1024;
            let encrypted: Uint8Array;
            try {
                encrypted = await downloadAttachment({ serverUrl: input.serverUrl, sessionId, token: input.credentials.token,
                    ref, timeoutMs: 60000, restrictOrigin: true, maxBytes: maxImageBytes + 40 });
            } catch { throw new Error('attachment-unavailable'); }
            // Revalidate scope/ownership after the async download before exposing plaintext.
            await client.sessions.get(sessionId);
            if (!input.resolveSessionEncryption(sessionId)) throw new Error('permission-denied');
            const bytes = decryptBlob(encrypted, key);
            if (!bytes || !bytes.length || bytes.length > maxImageBytes || detectCodexImage(bytes)?.mime !== mimeType) {
                throw new Error('invalid-request');
            }
            return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
        },
        start: input.start,
        cancel: sessionId => client.sessions.cancel(sessionId),
        dispose: () => client.dispose(),
    };
}
