import React, { memo, useState, useEffect } from 'react';
import { View, Text, ScrollView, Switch } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import QRCode from 'qrcode';
import { Image } from 'expo-image';
import { PublicSessionShare } from '@/sync/sharingTypes';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { t } from '@/text';
import { getServerUrl } from '@/sync/serverConfig';

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
    const [isCreating, setIsCreating] = useState(!publicShare);
    const [expiresInDays, setExpiresInDays] = useState<number | undefined>(7);
    const [maxUses, setMaxUses] = useState<number | undefined>(undefined);
    const [isConsentRequired, setIsConsentRequired] = useState(true);

    // Generate QR code when public share exists
    useEffect(() => {
        if (!publicShare) {
            setQrDataUrl(null);
            return;
        }

        // Use the configured server URL to generate the share link
        const serverUrl = getServerUrl();
        const url = `${serverUrl}/share/${publicShare.token}`;

        QRCode.toDataURL(url, {
            width: 300,
            margin: 2,
            color: {
                dark: '#000000',
                light: '#FFFFFF',
            },
        })
            .then(setQrDataUrl)
            .catch(console.error);
    }, [publicShare]);

    const handleCreate = () => {
        onCreate({
            expiresInDays,
            maxUses,
            isConsentRequired,
        });
        setIsCreating(false);
    };

    const formatDate = (timestamp: number) => {
        return new Date(timestamp).toLocaleDateString();
    };

    return (
        <View style={styles.container}>
            {isCreating ? (
                    // Create new public share form
                    <View style={styles.createForm}>
                        <Text style={styles.description}>
                            {t('session.sharing.publicLinkDescription')}
                        </Text>

                        {/* Expiration */}
                        <View style={styles.section}>
                            <Text style={styles.sectionTitle}>
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
                        <View style={styles.section}>
                            <Text style={styles.sectionTitle}>
                                {t('session.sharing.maxUses')}
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

                        {/* Consent required */}
                        <View style={styles.section}>
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
                    </View>
                ) : publicShare ? (
                    // Display existing public share
                    <View style={styles.existingShare}>
                        {/* QR Code */}
                        {qrDataUrl && (
                            <View style={styles.qrContainer}>
                                <Image
                                    source={{ uri: qrDataUrl }}
                                    style={{ width: 300, height: 300 }}
                                    contentFit="contain"
                                />
                            </View>
                        )}

                        {/* Link info */}
                        <View style={styles.infoSection}>
                            <Item
                                title={t('session.sharing.linkToken')}
                                subtitle={publicShare.token}
                                subtitleLines={1}
                            />
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
                        </View>
                    </View>
                ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        minHeight: 400,
        maxHeight: 600,
    },
    createForm: {
        padding: 16,
    },
    description: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginBottom: 24,
        lineHeight: 20,
    },
    section: {
        marginBottom: 24,
    },
    sectionTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 12,
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
    existingShare: {
        padding: 16,
    },
    qrContainer: {
        alignItems: 'center',
        marginBottom: 24,
        padding: 16,
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 12,
    },
    infoSection: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
        paddingTop: 16,
    },
}));
