import { memo, useState } from 'react';
import { View, Text, ScrollView, Switch } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { t } from '@/text';
import { PublicSessionShare } from '@/sync/sharingTypes';

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
 * Displays existing public link info or allows creating a new one
 * with configurable expiration, max uses, and consent requirements.
 */
export const PublicLinkDialog = memo(function PublicLinkDialog({
    publicShare,
    onCreate,
    onDelete,
    onCancel,
}: PublicLinkDialogProps) {
    const [expiresInDays, setExpiresInDays] = useState<number | undefined>(7);
    const [maxUses, setMaxUses] = useState<number | undefined>(undefined);
    const [isConsentRequired, setIsConsentRequired] = useState(true);

    const handleCreate = () => {
        onCreate({
            expiresInDays,
            maxUses,
            isConsentRequired,
        });
    };

    const formatDate = (timestamp: number) => {
        return new Date(timestamp).toLocaleDateString();
    };

    // Show existing public share info
    if (publicShare) {
        return (
            <ScrollView style={styles.container}>
                <View style={styles.header}>
                    <Text style={styles.title}>{t('session.sharing.publicLink')}</Text>
                </View>

                <View style={styles.content}>
                    {/* Active link info */}
                    <Item
                        title={t('session.sharing.publicLinkActive')}
                        showChevron={false}
                    />

                    {publicShare.expiresAt && (
                        <Item
                            title={t('session.sharing.expiresOn')}
                            subtitle={formatDate(publicShare.expiresAt)}
                            showChevron={false}
                        />
                    )}

                    <Item
                        title={t('session.sharing.usageCount')}
                        subtitle={
                            publicShare.maxUses
                                ? `${publicShare.useCount} / ${publicShare.maxUses}`
                                : `${publicShare.useCount}`
                        }
                        showChevron={false}
                    />

                    <Item
                        title={t('session.sharing.requireConsent')}
                        subtitle={publicShare.isConsentRequired ? 'Yes' : 'No'}
                        showChevron={false}
                    />

                    {/* Delete button */}
                    <View style={styles.buttonContainer}>
                        <Item
                            title={t('session.sharing.deletePublicLink')}
                            onPress={onDelete}
                            destructive
                        />
                    </View>

                    {/* Cancel */}
                    <View style={styles.buttonContainer}>
                        <Item
                            title={t('common.cancel')}
                            onPress={onCancel}
                        />
                    </View>
                </View>
            </ScrollView>
        );
    }

    // Show creation form
    return (
        <ScrollView style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title}>{t('session.sharing.publicLink')}</Text>
            </View>

            <View style={styles.content}>
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

                {/* Consent toggle */}
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
                    <Item
                        title={t('session.sharing.createPublicLink')}
                        onPress={handleCreate}
                    />
                </View>

                {/* Cancel */}
                <View style={styles.buttonContainer}>
                    <Item
                        title={t('common.cancel')}
                        onPress={onCancel}
                    />
                </View>
            </View>
        </ScrollView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        padding: 16,
    },
    header: {
        marginBottom: 12,
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
        paddingHorizontal: 4,
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
        paddingHorizontal: 4,
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
    buttonContainer: {
        marginTop: 16,
    },
}));
