import { useState, useCallback, useEffect, useRef } from 'react';
import { accessPublicShare, getPublicShareMessages } from '@/sync/apiSharing';
import { decryptDataKeyFromPublicShare } from '@/sync/encryption/publicShareEncryption';
import { AES256Encryption } from '@/sync/encryption/encryptor';
import { decodeBase64 } from '@/encryption/base64';
import { normalizeRawMessage } from '@/sync/typesRaw';
import { createReducer, reducer } from '@/sync/reducer/reducer';
import { getServerUrl } from '@/sync/serverConfig';
import { PublicShareNotFoundError, ConsentRequiredError, ShareUserProfile } from '@/sync/sharingTypes';
import { Message } from '@/sync/typesMessage';
import { Metadata, MetadataSchema } from '@/sync/storageTypes';

export type PublicShareState = 'loading' | 'loaded' | 'error' | 'consent-required' | 'not-found';

export function usePublicShareSession(token: string) {
    const [state, setState] = useState<PublicShareState>('loading');
    const [messages, setMessages] = useState<Message[]>([]);
    const [metadata, setMetadata] = useState<Metadata | null>(null);
    const [owner, setOwner] = useState<ShareUserProfile | null>(null);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const consentRef = useRef(false);

    const load = useCallback(async (withConsent: boolean) => {
        try {
            setState('loading');
            const serverUrl = getServerUrl();
            const consent = withConsent || undefined;

            // 1. Access public share to get session info + encrypted data key
            const shareData = await accessPublicShare(serverUrl, token, consent);
            setOwner(shareData.owner);
            setSessionId(shareData.session.id);

            // 2. Decrypt data key from token
            const dataKey = await decryptDataKeyFromPublicShare(shareData.encryptedDataKey, token);
            if (!dataKey) {
                setState('error');
                return;
            }

            const decryptor = new AES256Encryption(dataKey);

            // 3. Decrypt metadata
            if (shareData.session.metadata) {
                try {
                    const metadataBytes = decodeBase64(shareData.session.metadata, 'base64');
                    const [decryptedMetadata] = await decryptor.decrypt([metadataBytes]);
                    if (decryptedMetadata) {
                        const parsed = MetadataSchema.safeParse(decryptedMetadata);
                        if (parsed.success) {
                            setMetadata(parsed.data);
                        }
                    }
                } catch {
                    // Metadata decryption is non-critical
                }
            }

            // 4. Fetch encrypted messages
            const encryptedMessages = await getPublicShareMessages(serverUrl, token, consent);

            if (encryptedMessages.length === 0) {
                setMessages([]);
                setState('loaded');
                return;
            }

            // 5. Decrypt messages (reverse to get oldest first)
            const reversed = [...encryptedMessages].reverse();
            const encryptedBytes = reversed.map(m => decodeBase64(m.content.c, 'base64'));
            const decryptedContents = await decryptor.decrypt(encryptedBytes);

            // 6. Normalize messages
            const normalizedMessages = reversed
                .map((m, i) => {
                    const content = decryptedContents[i];
                    if (!content) return null;
                    return normalizeRawMessage(m.id, m.localId, m.createdAt, content);
                })
                .filter((m): m is NonNullable<typeof m> => m !== null);

            // 7. Reduce to Message[]
            const result = reducer(createReducer(), normalizedMessages);
            setMessages(result.messages.reverse());
            setState('loaded');
        } catch (e) {
            if (e instanceof PublicShareNotFoundError) {
                setState('not-found');
            } else if (e instanceof ConsentRequiredError) {
                setState('consent-required');
            } else {
                setState('error');
            }
        }
    }, [token]);

    useEffect(() => {
        load(false);
    }, [load]);

    const giveConsent = useCallback(() => {
        if (!consentRef.current) {
            consentRef.current = true;
            load(true);
        }
    }, [load]);

    return { state, messages, metadata, owner, sessionId, giveConsent };
}
