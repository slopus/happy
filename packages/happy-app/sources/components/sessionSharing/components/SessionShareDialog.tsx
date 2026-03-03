import * as React from 'react';
import { View } from 'react-native';
import { BottomSheetModal, BottomSheetBackdrop, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { Avatar } from '@/components/Avatar';
import { Text } from '@/components/StyledText';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { SessionShare, ShareAccessLevel } from '@/sync/sharingTypes';

export interface SessionShareDialogProps {
    sessionId: string;
    shares: SessionShare[];
    canManage: boolean;
    onAddShare: () => void;
    onUpdateShare: (shareId: string, accessLevel: ShareAccessLevel) => void;
    onRemoveShare: (shareId: string) => void;
}

export const SessionShareDialog = React.memo(React.forwardRef<BottomSheetModal, SessionShareDialogProps>(({
    shares,
    canManage,
    onAddShare,
    onUpdateShare,
    onRemoveShare,
}, ref) => {
    const { theme } = useUnistyles();
    const [selectedShareId, setSelectedShareId] = React.useState<string | null>(null);

    const handleSharePress = React.useCallback((shareId: string) => {
        if (canManage) {
            setSelectedShareId(selectedShareId === shareId ? null : shareId);
        }
    }, [canManage, selectedShareId]);

    const handleAccessLevelChange = React.useCallback((shareId: string, accessLevel: ShareAccessLevel) => {
        onUpdateShare(shareId, accessLevel);
        setSelectedShareId(null);
    }, [onUpdateShare]);

    const handleRemoveShare = React.useCallback((shareId: string) => {
        onRemoveShare(shareId);
        setSelectedShareId(null);
    }, [onRemoveShare]);

    const handleAddShare = React.useCallback(() => {
        if (ref && typeof ref !== 'function' && ref.current) {
            ref.current.dismiss();
        }
        onAddShare();
    }, [onAddShare, ref]);

    const renderBackdrop = React.useCallback(
        (props: any) => <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />,
        [],
    );

    return (
        <BottomSheetModal
            ref={ref}
            enableDynamicSizing={true}
            backdropComponent={renderBackdrop}
            backgroundStyle={{ backgroundColor: theme.colors.groupped.background }}
            handleIndicatorStyle={{ backgroundColor: theme.colors.textSecondary }}
        >
            <BottomSheetScrollView style={{ paddingBottom: 32 }}>
                <Text style={[styles.title, { color: theme.colors.text }]}>
                    {t('session.sharing.title')}
                </Text>

                {canManage && (
                    <ItemGroup>
                        <Item
                            title={t('session.sharing.shareWith')}
                            icon={<Ionicons name="person-add-outline" size={29} color="#007AFF" />}
                            onPress={handleAddShare}
                        />
                    </ItemGroup>
                )}

                {shares.length > 0 && (
                    <ItemGroup title={t('session.sharing.sharedWith')}>
                        {shares.map(share => (
                            <ShareItem
                                key={share.id}
                                share={share}
                                canManage={canManage}
                                isSelected={selectedShareId === share.id}
                                onPress={() => handleSharePress(share.id)}
                                onAccessLevelChange={handleAccessLevelChange}
                                onRemove={handleRemoveShare}
                            />
                        ))}
                    </ItemGroup>
                )}

                {shares.length === 0 && !canManage && (
                    <View style={styles.emptyState}>
                        <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                            {t('session.sharing.noShares')}
                        </Text>
                    </View>
                )}
            </BottomSheetScrollView>
        </BottomSheetModal>
    );
}));

interface ShareItemProps {
    share: SessionShare;
    canManage: boolean;
    isSelected: boolean;
    onPress: () => void;
    onAccessLevelChange: (shareId: string, accessLevel: ShareAccessLevel) => void;
    onRemove: (shareId: string) => void;
}

const ShareItem = React.memo(function ShareItem({
    share,
    canManage,
    isSelected,
    onPress,
    onAccessLevelChange,
    onRemove,
}: ShareItemProps) {
    const { theme } = useUnistyles();
    const accessLevelLabel = getAccessLevelLabel(share.accessLevel);
    const userName = share.sharedWithUser.username || [share.sharedWithUser.firstName, share.sharedWithUser.lastName]
        .filter(Boolean)
        .join(' ');

    return (
        <View>
            <Item
                title={userName || ''}
                subtitle={accessLevelLabel}
                leftElement={
                    <Avatar
                        id={share.sharedWithUser.id}
                        imageUrl={share.sharedWithUser.avatar}
                        size={32}
                    />
                }
                iconContainerStyle={{ marginRight: 16 }}
                onPress={canManage ? onPress : undefined}
                showChevron={canManage}
            />
            {isSelected && canManage && (
                <View style={{ paddingLeft: 24, backgroundColor: theme.colors.surfaceHigh }}>
                    <Item
                        title={t('session.sharing.viewOnly')}
                        subtitle={t('session.sharing.viewOnlyDescription')}
                        onPress={() => onAccessLevelChange(share.id, 'view')}
                        selected={share.accessLevel === 'view'}
                    />
                    <Item
                        title={t('session.sharing.canEdit')}
                        subtitle={t('session.sharing.canEditDescription')}
                        onPress={() => onAccessLevelChange(share.id, 'edit')}
                        selected={share.accessLevel === 'edit'}
                    />
                    <Item
                        title={t('session.sharing.canManage')}
                        subtitle={t('session.sharing.canManageDescription')}
                        onPress={() => onAccessLevelChange(share.id, 'admin')}
                        selected={share.accessLevel === 'admin'}
                    />
                    <Item
                        title={t('session.sharing.stopSharing')}
                        onPress={() => onRemove(share.id)}
                        destructive
                    />
                </View>
            )}
        </View>
    );
});

function getAccessLevelLabel(level: ShareAccessLevel): string {
    switch (level) {
        case 'view':
            return t('session.sharing.viewOnly');
        case 'edit':
            return t('session.sharing.canEdit');
        case 'admin':
            return t('session.sharing.canManage');
    }
}

const styles = StyleSheet.create((_theme) => ({
    title: {
        ...Typography.default('semiBold'),
        fontSize: 17,
        textAlign: 'center',
        paddingVertical: 8,
    },
    emptyState: {
        padding: 32,
        alignItems: 'center',
    },
    emptyText: {
        ...Typography.default(),
        fontSize: 16,
        textAlign: 'center',
    },
}));
