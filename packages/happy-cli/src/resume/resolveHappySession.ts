import axios, { AxiosError } from 'axios';
import tweetnacl from 'tweetnacl';
import { z } from 'zod';

import { decodeBase64, decryptLegacy, decryptWithDataKey } from '@/api/encryption';
import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import {
    getLocalHappyAgentCredentialPath,
    readLocalHappyAgentCredentials,
    type LocalHappyAgentCredentials,
} from './localHappyAgentAuth';

const ResumableMetadataSchema = z.object({
    path: z.string().min(1),
    flavor: z.string().optional(),
    claudeSessionId: z.string().optional(),
    codexThreadId: z.string().optional(),
}).passthrough();

const SyncNodeStoredSessionMetadataSchema = z.object({
    session: z.object({
        directory: z.string(),
        projectID: z.string(),
        title: z.string().optional(),
        parentID: z.string().nullable().optional(),
    }),
    metadata: z.unknown().nullable().optional(),
}).passthrough();

const SyncNodeSessionMetadataSchema = z.object({
    directory: z.string(),
    projectID: z.string(),
    title: z.string().optional(),
    parentID: z.string().nullable().optional(),
}).passthrough();

type RawSession = {
    id: string;
    active: boolean;
    metadata: string;
    dataEncryptionKey: string | null;
};

type RecordEncryption = {
    key: Uint8Array;
    variant: 'legacy' | 'dataKey';
};

export type ResumableHappySession = {
    id: string;
    active: boolean;
    metadata: Metadata;
};

export function resolveSessionRecordByPrefix<T extends { id: string }>(records: T[], sessionId: string): T {
    const trimmed = sessionId.trim();
    if (!trimmed) {
        throw new Error('Happy session ID is required: happy resume <session-id>');
    }

    const matches = records.filter((record) => record.id.startsWith(trimmed));
    if (matches.length === 0) {
        throw new Error(`No Happy session found matching "${trimmed}"`);
    }
    if (matches.length > 1) {
        throw new Error(`Ambiguous Happy session "${trimmed}" matches ${matches.length} sessions. Be more specific.`);
    }
    return matches[0];
}

function decryptBoxBundle(bundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
    if (bundle.length < 56) {
        return null;
    }

    const ephemeralPublicKey = bundle.slice(0, 32);
    const nonce = bundle.slice(32, 56);
    const ciphertext = bundle.slice(56);
    const decrypted = tweetnacl.box.open(ciphertext, nonce, ephemeralPublicKey, recipientSecretKey);

    return decrypted ? new Uint8Array(decrypted) : null;
}

function readAgentCredentials() {
    const credentialPath = getLocalHappyAgentCredentialPath();
    const credentials = readLocalHappyAgentCredentials();
    if (!credentials) {
        throw new Error(
            `Cannot resume historical Happy sessions without ${credentialPath}. Run \`happy auth login\` in this environment first.`,
        );
    }
    return credentials;
}

function resolveSessionEncryption(session: RawSession, credentials: LocalHappyAgentCredentials): RecordEncryption {
    if (session.dataEncryptionKey) {
        const encrypted = decodeBase64(session.dataEncryptionKey);
        const sessionKey = decryptBoxBundle(encrypted.slice(1), credentials.contentKeyPair.secretKey);
        if (!sessionKey) {
            throw new Error(`Failed to decrypt data key for Happy session ${session.id}`);
        }
        return {
            key: sessionKey,
            variant: 'dataKey',
        };
    }

    return {
        key: credentials.secret,
        variant: 'legacy',
    };
}

function decryptSessionMetadata(session: RawSession, credentials: LocalHappyAgentCredentials): Metadata {
    const encryption = resolveSessionEncryption(session, credentials);
    const encryptedMetadata = decodeBase64(session.metadata);
    const metadata = encryption.variant === 'dataKey'
        ? decryptWithDataKey(encryptedMetadata, encryption.key)
        : decryptLegacy(encryptedMetadata, encryption.key);

    if (!metadata) {
        throw new Error(`Failed to decrypt metadata for Happy session ${session.id}`);
    }

    const syncNodeEnvelope = SyncNodeStoredSessionMetadataSchema.safeParse(metadata);
    if (syncNodeEnvelope.success) {
        const nestedMetadata = syncNodeEnvelope.data.metadata;
        const nested = ResumableMetadataSchema.safeParse(nestedMetadata);
        if (nested.success) {
            return nested.data as Metadata;
        }

        const nestedRecord = nestedMetadata && typeof nestedMetadata === 'object'
            ? nestedMetadata as Record<string, unknown>
            : {};
        return {
            ...nestedRecord,
            path: typeof nestedRecord.path === 'string' && nestedRecord.path.length > 0
                ? nestedRecord.path
                : syncNodeEnvelope.data.session.directory,
        } as Metadata;
    }

    const syncNodeSessionMetadata = SyncNodeSessionMetadataSchema.safeParse(metadata);
    if (syncNodeSessionMetadata.success) {
        return {
            path: syncNodeSessionMetadata.data.directory,
        } as Metadata;
    }

    try {
        return ResumableMetadataSchema.parse(metadata) as Metadata;
    } catch {
        throw new Error(`Happy session ${session.id} is missing resumable metadata.`);
    }
}

export async function resolveHappySession(sessionId: string): Promise<ResumableHappySession> {
    const credentials = readAgentCredentials();

    let sessions: RawSession[];
    try {
        const response = await axios.get(`${configuration.serverUrl}/v1/sessions`, {
            headers: {
                Authorization: `Bearer ${credentials.token}`,
            },
        });
        sessions = (response.data as { sessions: RawSession[] }).sessions;
    } catch (error) {
        if (error instanceof AxiosError) {
            if (error.response?.status === 401) {
                throw new Error('Happy session lookup authentication expired. Run `happy auth login` in this environment.');
            }
            throw new Error(`Failed to load Happy sessions: ${error.message}`);
        }
        throw error;
    }

    const matched = resolveSessionRecordByPrefix(sessions, sessionId);
    return {
        id: matched.id,
        active: matched.active,
        metadata: decryptSessionMetadata(matched, credentials),
    };
}
