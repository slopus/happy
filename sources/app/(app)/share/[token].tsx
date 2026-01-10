import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { decryptDataKeyFromPublicShare } from '@/sync/publicShareEncryption';
import { Ionicons } from '@expo/vector-icons';
import { getServerUrl } from "@/sync/serverConfig";

/**
 * Public share access screen
 *
 * This screen handles accessing a session via a public share link.
 * The token from the URL is used to decrypt the session data key.
 */
export default function PublicShareAccessScreen() {
    const { token } = useLocalSearchParams<{ token: string }>();
    const router = useRouter();
    const { theme } = useUnistyles();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [shareInfo, setShareInfo] = useState<{
        sessionId: string;
        ownerName: string;
        requiresConsent: boolean;
    } | null>(null);

    useEffect(() => {
        if (!token) {
            setError(t('errors.invalidShareLink'));
            setLoading(false);
            return;
        }

        loadPublicShare();
    }, [token]);

    const loadPublicShare = async (withConsent: boolean = false) => {
        try {
            setLoading(true);
            setError(null);

            const credentials = sync.getCredentials();
            const serverUrl = getServerUrl();

            // Build URL with consent parameter if user has accepted
            const url = withConsent
                ? `${serverUrl}/v1/public-share/${token}?consent=true`
                : `${serverUrl}/v1/public-share/${token}`;

            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${credentials.token}`,
                },
            });

            if (!response.ok) {
                if (response.status === 404) {
                    setError(t('session.sharing.shareNotFound'));
                    setLoading(false);
                    return;
                } else if (response.status === 403) {
                    // Consent required but not provided
                    const data = await response.json();
                    if (data.requiresConsent) {
                        // Show consent screen with owner info from server
                        setShareInfo({
                            sessionId: data.sessionId || '',
                            ownerName: data.owner?.username || data.owner?.firstName || 'Unknown',
                            requiresConsent: true,
                        });
                        setLoading(false);
                        return;
                    }
                    setError(t('session.sharing.shareExpired'));
                    setLoading(false);
                    return;
                } else {
                    setError(t('errors.operationFailed'));
                    setLoading(false);
                    return;
                }
            }

            const data = await response.json();

            // Decrypt the data encryption key using the token
            const decryptedKey = await decryptDataKeyFromPublicShare(
                data.encryptedDataKey,
                token
            );

            if (!decryptedKey) {
                setError(t('session.sharing.failedToDecrypt'));
                setLoading(false);
                return;
            }

            // Store the decrypted key for this session
            sync.storePublicShareKey(data.session.id, decryptedKey);

            setShareInfo({
                sessionId: data.session.id,
                ownerName: data.owner?.username || data.owner?.firstName || 'Unknown',
                requiresConsent: false, // Successfully accessed, no need to show consent screen
            });
            setLoading(false);
        } catch (err) {
            console.error('Failed to load public share:', err);
            setError(t('errors.operationFailed'));
            setLoading(false);
        }
    };

    const handleAcceptConsent = () => {
        // Reload with consent=true to actually access the session
        loadPublicShare(true);
    };

    const handleDeclineConsent = () => {
        router.back();
    };

    if (loading) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.colors.groupped.background }}>
                <ActivityIndicator size="large" color={theme.colors.textLink} />
                <Text style={{ color: theme.colors.textSecondary, marginTop: 16, fontSize: 15 }}>
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    if (error) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.colors.groupped.background, paddingHorizontal: 32 }}>
                <Ionicons name="alert-circle-outline" size={64} color={theme.colors.textDestructive} />
                <Text style={{ color: theme.colors.text, fontSize: 20, fontWeight: '600', marginTop: 16, textAlign: 'center' }}>
                    {t('common.error')}
                </Text>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 15, marginTop: 8, textAlign: 'center' }}>
                    {error}
                </Text>
            </View>
        );
    }

    if (shareInfo && shareInfo.requiresConsent) {
        return (
            <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background }}>
                <ItemList>
                    <ItemGroup title={t('session.sharing.consentRequired')}>
                        <Item
                            title={t('session.sharing.sharedBy', { name: shareInfo.ownerName })}
                            icon={<Ionicons name="person-outline" size={29} color="#007AFF" />}
                            showChevron={false}
                        />
                        <Item
                            title={t('session.sharing.consentDescription')}
                            showChevron={false}
                        />
                    </ItemGroup>
                    <ItemGroup>
                        <Item
                            title={t('session.sharing.acceptAndView')}
                            icon={<Ionicons name="checkmark-circle-outline" size={29} color="#34C759" />}
                            onPress={handleAcceptConsent}
                        />
                        <Item
                            title={t('common.cancel')}
                            icon={<Ionicons name="close-circle-outline" size={29} color="#FF3B30" />}
                            onPress={handleDeclineConsent}
                        />
                    </ItemGroup>
                </ItemList>
            </View>
        );
    }

    // No consent required, navigate directly to session
    if (shareInfo) {
        router.replace(`/session/${shareInfo.sessionId}`);
        return null;
    }

    return null;
}
