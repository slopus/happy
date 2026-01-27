import React, { memo, useState, useEffect } from 'react';
import { View, Text, ScrollView, Switch, Platform, Linking } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import QRCode from 'qrcode';
import { Image } from 'expo-image';
import * as Clipboard from 'expo-clipboard';
import { PublicSessionShare } from '@/sync/sharingTypes';
import { Item } from '@/components/Item';
import { ItemList } from '@/components/ItemList';
import { RoundButton } from '@/components/RoundButton';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';
import { BaseModal } from '@/modal/components/BaseModal';
import { Modal } from '@/modal';

/**
 * Props for PublicLinkDialog component
 */
export interface PublicLinkDialogProps {
    /** Existing public share if any */
    publicShare: PublicSessionShare | null;
    /** Callback to create a new public share */
    onCreate: (options: {
        expiresInDays?: number;
        maxUses?: number;
        isConsentRequired: boolean;
    }) => void;
    /** Callback to delete the public share */
    onDelete: () => void;
    /** Callback when cancelled */
    onCancel: () => void;
}

/**
 * Dialog for managing public share links
 *
 * @remarks
 * Displays the current public link with QR code, or allows creating a new one.
 * Shows expiration date, usage count, and allows configuring consent requirement.
 */
export const PublicLinkDialog = memo(function PublicLinkDialog({
    publicShare,
    onCreate,
    onDelete,
    onCancel
}: PublicLinkDialogProps) {
    const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
    const [shareUrl, setShareUrl] = useState<string | null>(null);
    const [isConfiguring, setIsConfiguring] = useState(false);
    const [expiresInDays, setExpiresInDays] = useState<number | undefined>(7);
    const [maxUses, setMaxUses] = useState<number | undefined>(undefined);
    const [isConsentRequired, setIsConsentRequired] = useState(true);

    const buildPublicShareUrl = (token: string): string => {
        const path = `/share/${token}`;

        if (Platform.OS === 'web') {
            const origin =
                typeof window !== 'undefined' && window.location?.origin
                    ? window.location.origin
                    : '';
            return `${origin}${path}`;
        }

        const configuredWebAppUrl = (process.env.EXPO_PUBLIC_HAPPY_WEBAPP_URL || '').trim();
        const webAppUrl = configuredWebAppUrl || 'https://app.happy.engineering';
        return `${webAppUrl}${path}`;
    };

    // Generate QR code when public share exists
    useEffect(() => {
        if (!publicShare?.token) {
            setQrDataUrl(null);
            setShareUrl(null);
            return;
        }

        // IMPORTANT: Public share links point to the web app route (`/share/:token`),
        // not the API server URL.
        const url = buildPublicShareUrl(publicShare.token);
        setShareUrl(url);

        QRCode.toDataURL(url, {
            width: 250,
            margin: 2,
            color: {
                dark: '#000000',
                light: '#FFFFFF',
            },
        })
            .then(setQrDataUrl)
            .catch(() => setQrDataUrl(null));
    }, [publicShare?.token]);

    const handleCreate = () => {
        setIsConfiguring(false);
        onCreate({
            expiresInDays,
            maxUses,
            isConsentRequired,
        });
    };

    const formatDate = (timestamp: number) => {
        return new Date(timestamp).toLocaleDateString();
    };

    const handleOpenLink = async () => {
        if (!shareUrl) return;
        try {
            if (Platform.OS === 'web') {
                window.open(shareUrl, '_blank', 'noopener,noreferrer');
                return;
            }
            await Linking.openURL(shareUrl);
        } catch {
            // ignore
        }
    };

    const handleCopyLink = async () => {
        if (!shareUrl) return;
        try {
            await Clipboard.setStringAsync(shareUrl);
            Modal.alert(t('common.copied'), t('items.copiedToClipboard', { label: t('session.sharing.publicLink') }));
        } catch {
            Modal.alert(t('common.error'), t('textSelection.failedToCopy'));
        }
    };

    return (
        <BaseModal visible={true} onClose={onCancel}>
            <View style={styles.container}>
                <View style={styles.header}>
                    <Text style={styles.title}>{t('session.sharing.publicLink')}</Text>
                    <Item
                        title={t('common.cancel')}
                        onPress={onCancel}
                    />
                </View>

                <ScrollView style={styles.content}>
                    {!publicShare || isConfiguring ? (
                        <ItemList>
                        <Text style={styles.description}>
                            {t('session.sharing.publicLinkDescription')}
                        </Text>

                        {/* Expiration */}
                        <View style={styles.optionGroup}>
                            <Text style={styles.groupTitle}>
                                {t('session.sharing.expiresIn')}
                            </Text>
                            <Item
                                title={t('session.sharing.days7')}
                                onPress={() => setExpiresInDays(7)}
                                rightElement={
                                    expiresInDays === 7 ? (
                                        <View style={styles.radioSelected}>
                                            <View style={styles.radioDot} />
                                        </View>
                                    ) : (
                                        <View style={styles.radioUnselected} />
                                    )
                                }
                            />
                            <Item
                                title={t('session.sharing.days30')}
                                onPress={() => setExpiresInDays(30)}
                                rightElement={
                                    expiresInDays === 30 ? (
                                        <View style={styles.radioSelected}>
                                            <View style={styles.radioDot} />
                                        </View>
                                    ) : (
                                        <View style={styles.radioUnselected} />
                                    )
                                }
                            />
                            <Item
                                title={t('session.sharing.never')}
                                onPress={() => setExpiresInDays(undefined)}
                                rightElement={
                                    expiresInDays === undefined ? (
                                        <View style={styles.radioSelected}>
                                            <View style={styles.radioDot} />
                                        </View>
                                    ) : (
                                        <View style={styles.radioUnselected} />
                                    )
                                }
                            />
                        </View>

                        {/* Max uses */}
                        <View style={styles.optionGroup}>
                            <Text style={styles.groupTitle}>
                                {t('session.sharing.maxUsesLabel')}
                            </Text>
                            <Item
                                title={t('session.sharing.unlimited')}
                                onPress={() => setMaxUses(undefined)}
                                rightElement={
                                    maxUses === undefined ? (
                                        <View style={styles.radioSelected}>
                                            <View style={styles.radioDot} />
                                        </View>
                                    ) : (
                                        <View style={styles.radioUnselected} />
                                    )
                                }
                            />
                            <Item
                                title={t('session.sharing.uses10')}
                                onPress={() => setMaxUses(10)}
                                rightElement={
                                    maxUses === 10 ? (
                                        <View style={styles.radioSelected}>
                                            <View style={styles.radioDot} />
                                        </View>
                                    ) : (
                                        <View style={styles.radioUnselected} />
                                    )
                                }
                            />
                            <Item
                                title={t('session.sharing.uses50')}
                                onPress={() => setMaxUses(50)}
                                rightElement={
                                    maxUses === 50 ? (
                                        <View style={styles.radioSelected}>
                                            <View style={styles.radioDot} />
                                        </View>
                                    ) : (
                                        <View style={styles.radioUnselected} />
                                    )
                                }
                            />
                        </View>

                        {/* Consent */}
                        <View style={styles.optionGroup}>
                            <Item
                                title={t('session.sharing.requireConsent')}
                                subtitle={t('session.sharing.requireConsentDescription')}
                                rightElement={
                                    <Switch
                                        value={isConsentRequired}
                                        onValueChange={setIsConsentRequired}
                                    />
                                }
                            />
                        </View>

                        {/* Create button */}
                        <View style={styles.buttonContainer}>
                            <RoundButton
                                title={publicShare ? t('session.sharing.regeneratePublicLink') : t('session.sharing.createPublicLink')}
                                onPress={handleCreate}
                                size="large"
                                style={{ width: '100%', maxWidth: 400 }}
                            />
                        </View>
                    </ItemList>
                ) : publicShare ? (
                    <ItemList>
                        <Item
                            title={t('session.sharing.regeneratePublicLink')}
                            onPress={() => setIsConfiguring(true)}
                            icon={<Ionicons name="refresh-outline" size={29} color="#007AFF" />}
                        />

                        {/* QR Code */}
                        {qrDataUrl && (
                            <View style={styles.qrContainer}>
                                <Image
                                    source={{ uri: qrDataUrl }}
                                    style={{ width: 250, height: 250 }}
                                    contentFit="contain"
                                />
                            </View>
                        )}

                        {/* Public link */}
                        {shareUrl ? (
                            <>
                                <Item
                                    title={t('session.sharing.publicLink')}
                                    subtitle={<Text selectable>{shareUrl}</Text>}
                                    subtitleLines={0}
                                    onPress={handleOpenLink}
                                />
                                <Item
                                    title={t('common.copy')}
                                    icon={<Ionicons name="copy-outline" size={29} color="#007AFF" />}
                                    onPress={handleCopyLink}
                                />
                            </>
                        ) : null}

                        {/* Info */}
                        {publicShare.token ? (
                            <Item
                                title={t('session.sharing.linkToken')}
                                subtitle={publicShare.token}
                                subtitleLines={1}
                            />
                        ) : (
                            <Item
                                title={t('session.sharing.tokenNotRecoverable')}
                                subtitle={t('session.sharing.tokenNotRecoverableDescription')}
                                showChevron={false}
                            />
                        )}
                        {publicShare.expiresAt && (
                            <Item
                                title={t('session.sharing.expiresOn')}
                                subtitle={formatDate(publicShare.expiresAt)}
                            />
                        )}
                        <Item
                            title={t('session.sharing.usageCount')}
                            subtitle={
                                publicShare.maxUses
                                    ? t('session.sharing.usageCountWithMax', {
                                          used: publicShare.useCount,
                                          max: publicShare.maxUses,
                                      })
                                    : t('session.sharing.usageCountUnlimited', {
                                          used: publicShare.useCount,
                                      })
                            }
                        />
                        <Item
                            title={t('session.sharing.requireConsent')}
                            subtitle={
                                publicShare.isConsentRequired
                                    ? t('common.yes')
                                    : t('common.no')
                            }
                        />

                        {/* Delete button */}
                        <View style={styles.buttonContainer}>
                            <Item
                                title={t('session.sharing.deletePublicLink')}
                                onPress={onDelete}
                                destructive
                            />
                        </View>
                    </ItemList>
                ) : null}
                </ScrollView>
            </View>
        </BaseModal>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        width: 600,
        maxWidth: '90%',
        maxHeight: '80%',
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    title: {
        fontSize: 18,
        fontWeight: '600',
        color: theme.colors.text,
    },
    content: {
        flex: 1,
    },
    description: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 8,
        lineHeight: 20,
    },
    optionGroup: {
        marginTop: 16,
    },
    groupTitle: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        paddingHorizontal: 16,
        paddingBottom: 8,
        textTransform: 'uppercase',
    },
    radioSelected: {
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: 'transparent',
        borderWidth: 2,
        borderColor: theme.colors.radio.active,
        alignItems: 'center',
        justifyContent: 'center',
    },
    radioDot: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: theme.colors.radio.dot,
    },
    radioUnselected: {
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: 'transparent',
        borderWidth: 2,
        borderColor: theme.colors.radio.inactive,
    },
    qrContainer: {
        alignItems: 'center',
        padding: 24,
        backgroundColor: theme.colors.surface,
    },
    buttonContainer: {
        marginTop: 24,
        marginBottom: 16,
        paddingHorizontal: 16,
        alignItems: 'center',
    },
}));
