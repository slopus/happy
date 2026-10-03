import { decodeBase64 } from '@/encryption/base64';

export interface AppConversationAccess {
    app: { id: string; origin: string };
    conversationId: string;
    grantId: string;
    machineId: string;
    grantExpiresAt: string | null;
    machineEnvelope: string;
    token: string;
    expiresAt: string;
}

/** Bind the locally decrypted envelope before handing only its app key to the registered origin. */
export function appConversationHistoryUrl(access: AppConversationAccess, envelope: unknown, expected: { conversationId: string; grantId: string; machineId: string | null }) {
    if (!envelope || typeof envelope !== 'object') throw new Error('Invalid application envelope');
    const data = envelope as Record<string, unknown>;
    if (access.app.id !== 'relationship-advisor' || access.app.origin !== 'https://advisor.paws.rodeo'
        || access.conversationId !== expected.conversationId || access.grantId !== expected.grantId || access.machineId !== expected.machineId
        || data.v !== 1 || data.grantId !== access.grantId || data.appId !== access.app.id || data.machineId !== access.machineId
        || data.scope !== 'codex:chat' || data.expiresAt !== access.grantExpiresAt || typeof data.key !== 'string'
        || !/^[A-Za-z0-9+/]{43}=$/.test(data.key) || decodeBase64(data.key).length !== 32
        || !access.token.startsWith('paws_history.') || access.token.length > 4096
        || !Number.isFinite(Date.parse(access.expiresAt)) || Date.parse(access.expiresAt) <= Date.now()) throw new Error('Application history binding mismatch');
    const payload = { v: 1, appId: access.app.id, conversationId: access.conversationId, grantId: access.grantId, key: data.key, token: access.token, expiresAt: access.expiresAt };
    return `${access.app.origin}/?pawsConversation=${encodeURIComponent(access.conversationId)}#paws-history=${encodeURIComponent(JSON.stringify(payload))}`;
}
