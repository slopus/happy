import React, { memo, useState, useEffect } from 'react';
import { View, Text, ScrollView, Switch } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import QRCode from 'qrcode';
import { Image } from 'expo-image';
import { PublicSessionShare } from '@/sync/sharingTypes';
import { Item } from '@/components/Item';
import { t } from '@/text';
import { CustomModal } from '@/components/CustomModal';
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
        <CustomModal
            visible={true}
            onClose={onCancel}
            title={t('sessionSharing.publicLink')}
            buttons={
                isCreating
                    ? [
                          {
                              title: t('common.cancel'),
                              style: 'cancel',
                              onPress: onCancel,
                          },
                          {
                              title: t('common.create'),
                              style: 'default',
                              onPress: handleCreate,
                          },
                      ]
                    : [
                          {
                              title: t('common.close'),
                              style: 'cancel',
                              onPress: onCancel,
                          },
                          {
                              title: t('common.delete'),
                              style: 'destructive',
                              onPress: onDelete,
                          },
                      ]
            }
        >
            <ScrollView style={styles.container}>
                {isCreating ? (
                    // Create new public share form
                    <View style={styles.createForm}>
                        <Text style={styles.description}>
                            {t('sessionSharing.publicLinkDescription')}
                        </Text>

                        {/* Expiration */}
                        <View style={styles.section}>
                            <Text style={styles.sectionTitle}>
                                {t('sessionSharing.expiresIn')}
                            </Text>
                            <Item
                                title={t('sessionSharing.days7')}
                                onPress={() => setExpiresInDays(7)}
                                rightElement={
                                    expiresInDays === 7 ? (
                                        <View style={styles.radioSelected} />
                                    ) : (
                                        <View style={styles.radioUnselected} />
                                    )
                                }
                            />
                            <Item
                                title={t('sessionSharing.days30')}
                                onPress={() => setExpiresInDays(30)}
                                rightElement={
                                    expiresInDays === 30 ? (
                                        <View style={styles.radioSelected} />
                                    ) : (
                                        <View style={styles.radioUnselected} />
                                    )
                                }
                            />
                            <Item
                                title={t('sessionSharing.never')}
                                onPress={() => setExpiresInDays(undefined)}
                                rightElement={
                                    expiresInDays === undefined ? (
                                        <View style={styles.radioSelected} />
                                    ) : (
                                        <View style={styles.radioUnselected} />
                                    )
                                }
                            />
                        </View>

                        {/* Max uses */}
                        <View style={styles.section}>
                            <Text style={styles.sectionTitle}>
                                {t('sessionSharing.maxUses')}
                            </Text>
                            <Item
                                title={t('sessionSharing.unlimited')}
                                onPress={() => setMaxUses(undefined)}
                                rightElement={
                                    maxUses === undefined ? (
                                        <View style={styles.radioSelected} />
                                    ) : (
                                        <View style={styles.radioUnselected} />
                                    )
                                }
                            />
                            <Item
                                title={t('sessionSharing.uses10')}
                                onPress={() => setMaxUses(10)}
                                rightElement={
                                    maxUses === 10 ? (
                                        <View style={styles.radioSelected} />
                                    ) : (
                                        <View style={styles.radioUnselected} />
                                    )
                                }
                            />
                            <Item
                                title={t('sessionSharing.uses50')}
                                onPress={() => setMaxUses(50)}
                                rightElement={
                                    maxUses === 50 ? (
                                        <View style={styles.radioSelected} />
                                    ) : (
                                        <View style={styles.radioUnselected} />
                                    )
                                }
                            />
                        </View>

                        {/* Consent required */}
                        <View style={styles.section}>
                            <Item
                                title={t('sessionSharing.requireConsent')}
                                subtitle={t('sessionSharing.requireConsentDescription')}
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
                                title={t('sessionSharing.linkToken')}
                                subtitle={publicShare.token}
                                subtitleLines={1}
                            />
                            {publicShare.expiresAt && (
                                <Item
                                    title={t('sessionSharing.expiresOn')}
                                    subtitle={formatDate(publicShare.expiresAt)}
                                />
                            )}
                            <Item
                                title={t('sessionSharing.usageCount')}
                                subtitle={
                                    publicShare.maxUses
                                        ? t('sessionSharing.usageCountWithMax', {
                                              count: publicShare.useCount,
                                              max: publicShare.maxUses,
                                          })
                                        : t('sessionSharing.usageCountUnlimited', {
                                              count: publicShare.useCount,
                                          })
                                }
                            />
                            <Item
                                title={t('sessionSharing.requireConsent')}
                                subtitle={
                                    publicShare.isConsentRequired
                                        ? t('common.yes')
                                        : t('common.no')
                                }
                            />
                        </View>
                    </View>
                ) : null}
            </ScrollView>
        </CustomModal>
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
        color: theme.colors.typography,
        marginBottom: 12,
    },
    radioSelected: {
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: theme.colors.primary,
        borderWidth: 2,
        borderColor: theme.colors.primary,
    },
    radioUnselected: {
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: 'transparent',
        borderWidth: 2,
        borderColor: theme.colors.textSecondary,
    },
    existingShare: {
        padding: 16,
    },
    qrContainer: {
        alignItems: 'center',
        marginBottom: 24,
        padding: 16,
        backgroundColor: theme.colors.background,
        borderRadius: 12,
    },
    infoSection: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        paddingTop: 16,
    },
}));
