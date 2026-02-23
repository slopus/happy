import * as React from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { BottomSheetModal, BottomSheetFlatList, BottomSheetTextInput, BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { DooTaskDialogUser } from '@/sync/dootask/types';

const AVATAR_SIZE = 40;

function resolveAvatarUrl(avatarPath: string | null | undefined, serverUrl: string): string | null {
    if (!avatarPath) return null;
    const base = serverUrl.replace(/\/+$/, '') + '/';
    const resolved = avatarPath.replace(/\{\{RemoteURL\}\}/g, base);
    if (resolved.startsWith('http') || resolved.startsWith('//')) return resolved;
    return base + resolved.replace(/^\/+/, '');
}

/** Map DooTask group_type values to localized labels. */
function getGroupTypeLabel(groupType: string): string {
    switch (groupType) {
        case 'all': return t('dootask.groupTypeAll');
        case 'department': return t('dootask.groupTypeDepartment');
        case 'project': return t('dootask.groupTypeProject');
        case 'task': return t('dootask.groupTypeTask');
        case 'okr': return t('dootask.groupTypeOkr');
        case 'user': return t('dootask.groupTypeUser');
        default: return groupType;
    }
}

type DialogDetailModalProps = {
    dialogName: string;
    dialogId: number;
    groupType: string;
    ownerId: number;
    members: DooTaskDialogUser[];
    loading: boolean;
    serverUrl: string;
};

export const DialogDetailModal = React.memo(React.forwardRef<BottomSheetModal, DialogDetailModalProps>(({
    dialogName, dialogId, groupType, ownerId, members, loading, serverUrl,
}, ref) => {
    const { theme } = useUnistyles();
    const [search, setSearch] = React.useState('');

    const filtered = React.useMemo(() => {
        if (!search.trim()) return members;
        const q = search.toLowerCase();
        return members.filter(u => u.nickname?.toLowerCase().includes(q));
    }, [members, search]);

    // Reset search when sheet dismisses
    const handleDismiss = React.useCallback(() => {
        setSearch('');
    }, []);

    const renderBackdrop = React.useCallback(
        (props: any) => <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />,
        [],
    );

    const renderMember = React.useCallback(({ item }: { item: DooTaskDialogUser }) => {
        const avatarUrl = resolveAvatarUrl(item.userimg, serverUrl);
        const isOwner = item.userid === ownerId;
        const isDisabled = !!item.disable_at;
        return (
            <View style={memberStyles.row}>
                <View style={memberStyles.avatarWrap}>
                    {avatarUrl ? (
                        <Image source={{ uri: avatarUrl }}
                            style={{ width: AVATAR_SIZE, height: AVATAR_SIZE, borderRadius: AVATAR_SIZE / 2, opacity: isDisabled ? 0.4 : 1 }}
                        />
                    ) : (
                        <View style={[memberStyles.avatarPlaceholder, { backgroundColor: theme.colors.surfaceHighest, opacity: isDisabled ? 0.4 : 1 }]}>
                            <Text style={{ color: theme.colors.text, fontSize: 16, fontWeight: '600' }}>
                                {(item.nickname || '?')[0].toUpperCase()}
                            </Text>
                        </View>
                    )}
                </View>
                <Text style={[memberStyles.name, { color: isDisabled ? theme.colors.textSecondary : theme.colors.text }]} numberOfLines={1}>
                    {item.nickname}
                </Text>
                {isOwner ? (
                    <View style={memberStyles.ownerBadge}>
                        <Text style={memberStyles.ownerText}>{t('dootask.groupOwner')}</Text>
                    </View>
                ) : null}
            </View>
        );
    }, [serverUrl, ownerId, theme]);

    const groupTypeLabel = getGroupTypeLabel(groupType);

    const ListHeaderComponent = React.useMemo(() => (
        <>
            {/* Dialog info */}
            <View style={sheetStyles.infoSection}>
                <Text style={[sheetStyles.label, { color: theme.colors.textSecondary }]}>{t('dootask.dialogName')}</Text>
                <Text style={[sheetStyles.value, { color: theme.colors.text }]}>{dialogName}</Text>

                <Text style={[sheetStyles.label, { color: theme.colors.textSecondary, marginTop: 16 }]}>{t('dootask.dialogId')}</Text>
                <Text style={[sheetStyles.value, { color: theme.colors.text }]}>{dialogId}</Text>

                <Text style={[sheetStyles.label, { color: theme.colors.textSecondary, marginTop: 16 }]}>{t('dootask.groupType')}</Text>
                <Text style={[sheetStyles.value, { color: theme.colors.text }]}>{groupTypeLabel}</Text>
            </View>

            {/* Search */}
            <View style={[sheetStyles.searchContainer, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }]}>
                <Ionicons name="search" size={18} color={theme.colors.textSecondary} />
                <BottomSheetTextInput
                    style={[sheetStyles.searchInput, { color: theme.colors.text }]}
                    placeholder={t('dootask.searchMembers')}
                    placeholderTextColor={theme.colors.textSecondary}
                    value={search}
                    onChangeText={setSearch}
                />
            </View>
        </>
    ), [theme, dialogName, dialogId, groupTypeLabel, search, setSearch]);

    return (
        <BottomSheetModal
            ref={ref}
            snapPoints={['90%']}
            enableDynamicSizing={false}
            backdropComponent={renderBackdrop}
            onDismiss={handleDismiss}
            backgroundStyle={{ backgroundColor: theme.colors.surface }}
            handleIndicatorStyle={{ backgroundColor: theme.colors.textSecondary }}
        >
            {loading && members.length === 0 ? (
                <View style={{ flex: 1, alignItems: 'center', paddingTop: 40 }}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            ) : (
                <BottomSheetFlatList
                    data={filtered}
                    keyExtractor={(item: DooTaskDialogUser) => String(item.userid)}
                    renderItem={renderMember}
                    ListHeaderComponent={ListHeaderComponent}
                    contentContainerStyle={{ paddingBottom: 20 }}
                    keyboardShouldPersistTaps="handled"
                />
            )}
        </BottomSheetModal>
    );
}));

const sheetStyles = StyleSheet.create((theme) => ({
    infoSection: {
        paddingHorizontal: theme.margins.lg,
        paddingVertical: theme.margins.md,
    },
    label: {
        ...Typography.default(),
        fontSize: 13,
    },
    value: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        marginTop: 2,
    },
    searchContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: theme.margins.lg,
        marginVertical: theme.margins.md,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
        gap: 8,
    },
    searchInput: {
        ...Typography.default(),
        flex: 1,
        fontSize: 15,
        lineHeight: 20,
        padding: 0,
    },
}));

const memberStyles = StyleSheet.create((_theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: _theme.margins.lg,
        paddingVertical: 12,
        gap: 12,
    },
    avatarWrap: {
        width: AVATAR_SIZE,
        height: AVATAR_SIZE,
    },
    avatarPlaceholder: {
        width: AVATAR_SIZE,
        height: AVATAR_SIZE,
        borderRadius: AVATAR_SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    name: {
        ...Typography.default(),
        fontSize: 15,
        flex: 1,
    },
    ownerBadge: {
        backgroundColor: '#4CAF50',
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 4,
    },
    ownerText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: '#FFFFFF',
    },
}));
