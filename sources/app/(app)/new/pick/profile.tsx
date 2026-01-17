import React from 'react';
import { Stack, useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSetting, useSettingMutable } from '@/sync/storage';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { AIBackendProfile } from '@/sync/settings';
import { Modal } from '@/modal';
import { ProfileCompatibilityIcon } from '@/components/newSession/ProfileCompatibilityIcon';
import { buildProfileGroups, toggleFavoriteProfileId } from '@/sync/profileGrouping';
import { ItemRowActions } from '@/components/ItemRowActions';
import { buildProfileActions } from '@/components/profileActions';
import type { ItemAction } from '@/components/ItemActionsMenuModal';
import { ignoreNextRowPress } from '@/utils/ignoreNextRowPress';

export default React.memo(function ProfilePickerScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{ selectedId?: string; machineId?: string; profileId?: string | string[] }>();
    const useProfiles = useSetting('useProfiles');
    const experimentsEnabled = useSetting('experiments');
    const [profiles, setProfiles] = useSettingMutable('profiles');
    const [favoriteProfileIds, setFavoriteProfileIds] = useSettingMutable('favoriteProfiles');

    const selectedId = typeof params.selectedId === 'string' ? params.selectedId : '';
    const machineId = typeof params.machineId === 'string' ? params.machineId : undefined;
    const profileId = Array.isArray(params.profileId) ? params.profileId[0] : params.profileId;
    const ignoreProfileRowPressRef = React.useRef(false);

    const renderProfileIcon = React.useCallback((profile: AIBackendProfile) => {
        return <ProfileCompatibilityIcon profile={profile} />;
    }, []);

    const getProfileBackendSubtitle = React.useCallback((profile: Pick<AIBackendProfile, 'compatibility'>) => {
        const parts: string[] = [];
        if (profile.compatibility?.claude) parts.push(t('agentInput.agent.claude'));
        if (profile.compatibility?.codex) parts.push(t('agentInput.agent.codex'));
        if (experimentsEnabled && profile.compatibility?.gemini) parts.push(t('agentInput.agent.gemini'));
        return parts.length > 0 ? parts.join(' • ') : '';
    }, [experimentsEnabled]);

    const getProfileSubtitle = React.useCallback((profile: AIBackendProfile) => {
        const backend = getProfileBackendSubtitle(profile);
        if (profile.isBuiltIn) {
            const builtInLabel = t('profiles.builtIn');
            return backend ? `${builtInLabel} · ${backend}` : builtInLabel;
        }
        const customLabel = t('profiles.custom');
        return backend ? `${customLabel} · ${backend}` : customLabel;
    }, [getProfileBackendSubtitle]);

    const setProfileParamAndClose = React.useCallback((profileId: string) => {
        const state = navigation.getState();
        const previousRoute = state?.routes?.[state.index - 1];
        if (state && state.index > 0 && previousRoute) {
            navigation.dispatch({
                type: 'SET_PARAMS',
                payload: { params: { profileId } },
                source: previousRoute.key,
            } as never);
        }
        router.back();
    }, [navigation, router]);

    const handleProfileRowPress = React.useCallback((profileId: string) => {
        if (ignoreProfileRowPressRef.current) {
            ignoreProfileRowPressRef.current = false;
            return;
        }
        setProfileParamAndClose(profileId);
    }, [setProfileParamAndClose]);

    React.useEffect(() => {
        if (typeof profileId === 'string' && profileId.length > 0) {
            setProfileParamAndClose(profileId);
        }
    }, [profileId, setProfileParamAndClose]);

    const openProfileCreate = React.useCallback(() => {
        router.push({
            pathname: '/new/pick/profile-edit',
            params: machineId ? { machineId } : {},
        });
    }, [machineId, router]);

    const openProfileEdit = React.useCallback((profileId: string) => {
        router.push({
            pathname: '/new/pick/profile-edit',
            params: machineId ? { profileId, machineId } : { profileId },
        });
    }, [machineId, router]);

    const openProfileDuplicate = React.useCallback((cloneFromProfileId: string) => {
        router.push({
            pathname: '/new/pick/profile-edit',
            params: machineId ? { cloneFromProfileId, machineId } : { cloneFromProfileId },
        });
    }, [machineId, router]);

    const {
        favoriteProfiles: favoriteProfileItems,
        customProfiles: nonFavoriteCustomProfiles,
        builtInProfiles: nonFavoriteBuiltInProfiles,
        favoriteIds: favoriteProfileIdSet,
    } = React.useMemo(() => {
        return buildProfileGroups({ customProfiles: profiles, favoriteProfileIds });
    }, [favoriteProfileIds, profiles]);

    const isDefaultEnvironmentFavorite = favoriteProfileIdSet.has('');

    const toggleFavoriteProfile = React.useCallback((profileId: string) => {
        setFavoriteProfileIds(toggleFavoriteProfileId(favoriteProfileIds, profileId));
    }, [favoriteProfileIds, setFavoriteProfileIds]);

    const handleAddProfile = React.useCallback(() => {
        openProfileCreate();
    }, [openProfileCreate]);

    const handleDeleteProfile = React.useCallback((profile: AIBackendProfile) => {
        Modal.alert(
            t('profiles.delete.title'),
            t('profiles.delete.message', { name: profile.name }),
            [
                { text: t('profiles.delete.cancel'), style: 'cancel' },
                {
                    text: t('profiles.delete.confirm'),
                    style: 'destructive',
                    onPress: () => {
                        // Only custom profiles live in `profiles` setting.
                        const updatedProfiles = profiles.filter(p => p.id !== profile.id);
                        setProfiles(updatedProfiles);
                        if (selectedId === profile.id) {
                            setProfileParamAndClose('');
                        }
                    },
                },
            ],
        );
    }, [profiles, selectedId, setProfileParamAndClose, setProfiles]);

    const renderProfileRowRightElement = React.useCallback(
        (profile: AIBackendProfile, isSelected: boolean, isFavorite: boolean) => {
            const actions = buildProfileActions({
                profile,
                isFavorite,
                favoriteActionColor: theme.colors.text,
                nonFavoriteActionColor: theme.colors.textSecondary,
                onToggleFavorite: () => toggleFavoriteProfile(profile.id),
                onEdit: () => openProfileEdit(profile.id),
                onDuplicate: () => openProfileDuplicate(profile.id),
                onDelete: () => handleDeleteProfile(profile),
            });

            return (
                <View style={styles.rowRightElement}>
                    <View style={styles.indicatorSlot}>
                        <Ionicons
                            name="checkmark-circle"
                            size={24}
                            color={theme.colors.text}
                            style={isSelected ? styles.selectedIndicatorVisible : styles.selectedIndicatorHidden}
                        />
                    </View>
                    <ItemRowActions
                        title={profile.name}
                        actions={actions}
                        compactActionIds={['favorite', 'edit']}
                        iconSize={20}
                        onActionPressIn={() => {
                            ignoreNextRowPress(ignoreProfileRowPressRef);
                        }}
                    />
                </View>
            );
        },
        [
            handleDeleteProfile,
            openProfileEdit,
            openProfileDuplicate,
            theme.colors.text,
            theme.colors.textSecondary,
            toggleFavoriteProfile,
        ],
    );

    const renderDefaultEnvironmentRowRightElement = React.useCallback((isSelected: boolean) => {
        const isFavorite = isDefaultEnvironmentFavorite;
        const actions: ItemAction[] = [
            {
                id: 'favorite',
                title: isFavorite ? t('profiles.actions.removeFromFavorites') : t('profiles.actions.addToFavorites'),
                icon: isFavorite ? 'star' : 'star-outline',
                onPress: () => toggleFavoriteProfile(''),
                color: isFavorite ? theme.colors.text : theme.colors.textSecondary,
            },
        ];

        return (
            <View style={styles.rowRightElement}>
                <View style={styles.indicatorSlot}>
                    <Ionicons
                        name="checkmark-circle"
                        size={24}
                        color={theme.colors.text}
                        style={isSelected ? styles.selectedIndicatorVisible : styles.selectedIndicatorHidden}
                    />
                </View>
                <ItemRowActions
                    title={t('profiles.noProfile')}
                    actions={actions}
                    compactActionIds={['favorite']}
                    iconSize={20}
                    onActionPressIn={() => {
                        ignoreNextRowPress(ignoreProfileRowPressRef);
                    }}
                />
            </View>
        );
    }, [isDefaultEnvironmentFavorite, theme.colors.text, theme.colors.textSecondary, toggleFavoriteProfile]);

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: t('profiles.title'),
                    headerBackTitle: t('common.back'),
                }}
            />

            <ItemList style={styles.itemList}>
                {!useProfiles ? (
                    <ItemGroup footer={t('settingsFeatures.profilesDisabled')}>
                        <Item
                            title={t('settingsFeatures.profiles')}
                            subtitle={t('settingsFeatures.profilesDisabled')}
                            icon={<Ionicons name="person-outline" size={29} color={theme.colors.textSecondary} />}
                            showChevron={false}
                        />
                        <Item
                            title={t('settings.featuresTitle')}
                            subtitle={t('settings.featuresSubtitle')}
                            icon={<Ionicons name="flask-outline" size={29} color={theme.colors.textSecondary} />}
                            onPress={() => router.push('/settings/features')}
                        />
                    </ItemGroup>
                ) : (
                    <>
                        {(isDefaultEnvironmentFavorite || favoriteProfileItems.length > 0) && (
                            <ItemGroup title={t('profiles.groups.favorites')}>
                                {isDefaultEnvironmentFavorite && (
                                    <Item
                                        title={t('profiles.noProfile')}
                                        subtitle={t('profiles.noProfileDescription')}
                                        icon={<Ionicons name="home-outline" size={29} color={theme.colors.textSecondary} />}
                                        onPress={() => handleProfileRowPress('')}
                                        showChevron={false}
                                        selected={selectedId === ''}
                                        rightElement={renderDefaultEnvironmentRowRightElement(selectedId === '')}
                                        showDivider={favoriteProfileItems.length > 0}
                                    />
                                )}
                                {favoriteProfileItems.map((profile, index) => {
                                    const isSelected = selectedId === profile.id;
                                    const isLast = index === favoriteProfileItems.length - 1;
                                    return (
                                        <Item
                                            key={profile.id}
                                            title={profile.name}
                                            subtitle={getProfileSubtitle(profile)}
                                            icon={renderProfileIcon(profile)}
                                            onPress={() => handleProfileRowPress(profile.id)}
                                            showChevron={false}
                                            selected={isSelected}
                                            rightElement={renderProfileRowRightElement(profile, isSelected, true)}
                                            showDivider={!isLast}
                                        />
                                    );
                                })}
                            </ItemGroup>
                        )}

                        {nonFavoriteCustomProfiles.length > 0 && (
                            <ItemGroup title={t('profiles.groups.custom')}>
                                {nonFavoriteCustomProfiles.map((profile, index) => {
                                    const isSelected = selectedId === profile.id;
                                    const isLast = index === nonFavoriteCustomProfiles.length - 1;
                                    const isFavorite = favoriteProfileIdSet.has(profile.id);
                                    return (
                                        <Item
                                            key={profile.id}
                                            title={profile.name}
                                            subtitle={getProfileSubtitle(profile)}
                                            icon={renderProfileIcon(profile)}
                                            onPress={() => handleProfileRowPress(profile.id)}
                                            showChevron={false}
                                            selected={isSelected}
                                            rightElement={renderProfileRowRightElement(profile, isSelected, isFavorite)}
                                            showDivider={!isLast}
                                        />
                                    );
                                })}
                            </ItemGroup>
                        )}

                        <ItemGroup title={t('profiles.groups.builtIn')}>
                            {!isDefaultEnvironmentFavorite && (
                                <Item
                                    title={t('profiles.noProfile')}
                                    subtitle={t('profiles.noProfileDescription')}
                                    icon={<Ionicons name="home-outline" size={29} color={theme.colors.textSecondary} />}
                                    onPress={() => handleProfileRowPress('')}
                                    showChevron={false}
                                    selected={selectedId === ''}
                                    rightElement={renderDefaultEnvironmentRowRightElement(selectedId === '')}
                                    showDivider={nonFavoriteBuiltInProfiles.length > 0}
                                />
                            )}
                            {nonFavoriteBuiltInProfiles.map((profile, index) => {
                                const isSelected = selectedId === profile.id;
                                const isLast = index === nonFavoriteBuiltInProfiles.length - 1;
                                const isFavorite = favoriteProfileIdSet.has(profile.id);
                                return (
                                    <Item
                                        key={profile.id}
                                        title={profile.name}
                                        subtitle={getProfileSubtitle(profile)}
                                        icon={renderProfileIcon(profile)}
                                        onPress={() => handleProfileRowPress(profile.id)}
                                        showChevron={false}
                                        selected={isSelected}
                                        rightElement={renderProfileRowRightElement(profile, isSelected, isFavorite)}
                                        showDivider={!isLast}
                                    />
                                );
                            })}
                        </ItemGroup>

                        <ItemGroup>
                            <Item
                                title={t('profiles.addProfile')}
                                icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.button.secondary.tint} />}
                                onPress={handleAddProfile}
                                showChevron={false}
                            />
                        </ItemGroup>
                    </>
                )}
            </ItemList>
        </>
    );
});

const stylesheet = StyleSheet.create(() => ({
    itemList: {
        paddingTop: 0,
    },
    rowRightElement: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
    },
    indicatorSlot: {
        width: 24,
        alignItems: 'center',
        justifyContent: 'center',
    },
    selectedIndicatorVisible: {
        opacity: 1,
    },
    selectedIndicatorHidden: {
        opacity: 0,
    },
}));
