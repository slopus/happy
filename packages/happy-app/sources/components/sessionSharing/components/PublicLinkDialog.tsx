import * as React from 'react';
import { View, Switch } from 'react-native';
import { BottomSheetModal, BottomSheetBackdrop, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { StyleSheet } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { Text } from '@/components/StyledText';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { PublicSessionShare } from '@/sync/sharingTypes';

export interface PublicLinkDialogProps {
    publicShare: PublicSessionShare | null;
    onCreate: (options: {
        expiresInDays?: number;
        maxUses?: number;
        isConsentRequired: boolean;
    }) => void;
    onDelete: () => void;
}

export const PublicLinkDialog = React.memo(React.forwardRef<BottomSheetModal, PublicLinkDialogProps>(({
    publicShare,
    onCreate,
    onDelete,
}, ref) => {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const [expiresInDays, setExpiresInDays] = React.useState<number | undefined>(7);
    const [maxUses, setMaxUses] = React.useState<number | undefined>(undefined);
    const [isConsentRequired, setIsConsentRequired] = React.useState(true);

    const handleCreate = React.useCallback(() => {
        onCreate({ expiresInDays, maxUses, isConsentRequired });
        if (ref && typeof ref !== 'function' && ref.current) {
            ref.current.dismiss();
        }
    }, [expiresInDays, maxUses, isConsentRequired, onCreate, ref]);

    const handleDelete = React.useCallback(() => {
        onDelete();
        if (ref && typeof ref !== 'function' && ref.current) {
            ref.current.dismiss();
        }
    }, [onDelete, ref]);

    const renderBackdrop = React.useCallback(
        (props: any) => <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />,
        [],
    );

    const formatDate = (timestamp: number) => new Date(timestamp).toLocaleDateString();

    return (
        <BottomSheetModal
            ref={ref}
            enableDynamicSizing={true}
            backdropComponent={renderBackdrop}
            backgroundStyle={{ backgroundColor: theme.colors.groupped.background }}
            handleIndicatorStyle={{ backgroundColor: theme.colors.textSecondary }}
        >
            <BottomSheetScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>
                <Text style={[styles.title, { color: theme.colors.text }]}>
                    {t('session.sharing.publicLink')}
                </Text>

                {publicShare ? (
                    <>
                        <ItemGroup>
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
                                subtitle={publicShare.isConsentRequired ? t('common.yes') : t('common.no')}
                                showChevron={false}
                            />
                        </ItemGroup>
                        <ItemGroup>
                            <Item
                                title={t('session.sharing.deletePublicLink')}
                                onPress={handleDelete}
                                destructive
                            />
                        </ItemGroup>
                    </>
                ) : (
                    <>
                        <ItemGroup title={t('session.sharing.expiresIn')}>
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
                        </ItemGroup>

                        <ItemGroup title={t('session.sharing.maxUsesLabel')}>
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
                        </ItemGroup>

                        <ItemGroup>
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
                        </ItemGroup>

                        <ItemGroup>
                            <Item
                                title={t('session.sharing.createPublicLink')}
                                onPress={handleCreate}
                            />
                        </ItemGroup>
                    </>
                )}
            </BottomSheetScrollView>
        </BottomSheetModal>
    );
}));

const styles = StyleSheet.create((theme) => ({
    title: {
        ...Typography.default('semiBold'),
        fontSize: 17,
        textAlign: 'center',
        paddingVertical: 8,
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
}));
