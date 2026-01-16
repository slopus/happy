import React from 'react';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { CommonActions, useNavigation } from '@react-navigation/native';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSetting, useSettingMutable } from '@/sync/storage';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';
import { AIBackendProfile } from '@/sync/settings';
import { Modal } from '@/modal';
import { ProfileCompatibilityIcon } from '@/components/newSession/ProfileCompatibilityIcon';
import { buildProfileGroups } from '@/sync/profileGrouping';
import { ItemRowActions } from '@/components/ItemRowActions';
import type { ItemAction } from '@/components/ItemActionsMenuModal';

export default function ProfilePickerScreen() {
    const { theme } = useUnistyles();
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
            return backend ? `Built-in · ${backend}` : 'Built-in';
        }
        return backend;
    }, [getProfileBackendSubtitle]);

    const setProfileParamAndClose = React.useCallback((profileId: string) => {
        const state = navigation.getState();
        const previousRoute = state?.routes?.[state.index - 1];
        if (state && state.index > 0 && previousRoute) {
            navigation.dispatch({
                ...CommonActions.setParams({ profileId }),
                source: previousRoute.key,
            } as never);
        }
        router.back();
    }, [navigation, router]);

    React.useEffect(() => {
        if (typeof profileId === 'string' && profileId.length > 0) {
            setProfileParamAndClose(profileId);
        }
    }, [profileId, setProfileParamAndClose]);

    const openProfileCreate = React.useCallback(() => {
        const base = '/new/pick/profile-edit';
        router.push(machineId ? `${base}?machineId=${encodeURIComponent(machineId)}` as any : base as any);
    }, [machineId, router]);

    const openProfileEdit = React.useCallback((profileId: string) => {
        const base = `/new/pick/profile-edit?profileId=${encodeURIComponent(profileId)}`;
        router.push(machineId ? `${base}&machineId=${encodeURIComponent(machineId)}` as any : base as any);
    }, [machineId, router]);

    const openProfileDuplicate = React.useCallback((cloneFromProfileId: string) => {
        const base = `/new/pick/profile-edit?cloneFromProfileId=${encodeURIComponent(cloneFromProfileId)}`;
        router.push(machineId ? `${base}&machineId=${encodeURIComponent(machineId)}` as any : base as any);
    }, [machineId, router]);

    const {
        favoriteProfiles: favoriteProfileItems,
        customProfiles: nonFavoriteCustomProfiles,
        builtInProfiles: nonFavoriteBuiltInProfiles,
        favoriteIds: favoriteProfileIdSet,
    } = React.useMemo(() => {
        return buildProfileGroups({ customProfiles: profiles, favoriteProfileIds });
    }, [favoriteProfileIds, profiles]);

    const toggleFavoriteProfile = React.useCallback((profileId: string) => {
        if (favoriteProfileIdSet.has(profileId)) {
            setFavoriteProfileIds(favoriteProfileIds.filter((id) => id !== profileId));
        } else {
            setFavoriteProfileIds([profileId, ...favoriteProfileIds]);
        }
    }, [favoriteProfileIdSet, favoriteProfileIds, setFavoriteProfileIds]);

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
            const actions: ItemAction[] = [
                {
                    id: 'favorite',
                    title: isFavorite ? 'Remove from favorites' : 'Add to favorites',
                    icon: isFavorite ? 'star' : 'star-outline',
                    color: isFavorite ? theme.colors.text : theme.colors.textSecondary,
                    onPress: () => toggleFavoriteProfile(profile.id),
                },
                {
                    id: 'edit',
                    title: 'Edit profile',
                    icon: 'create-outline',
                    onPress: () => openProfileEdit(profile.id),
                },
                {
                    id: 'copy',
                    title: 'Duplicate profile',
                    icon: 'copy-outline',
                    onPress: () => openProfileDuplicate(profile.id),
                },
            ];

            if (!profile.isBuiltIn) {
                actions.push({
                    id: 'delete',
                    title: 'Delete profile',
                    icon: 'trash-outline',
                    destructive: true,
                    onPress: () => handleDeleteProfile(profile),
                });
            }

            return (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                    <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
                        <Ionicons
                            name="checkmark-circle"
                            size={24}
                            color={theme.colors.text}
                            style={{ opacity: isSelected ? 1 : 0 }}
                        />
                    </View>
                    <ItemRowActions
                        title={profile.name}
                        actions={actions}
                        compactActionIds={['edit']}
                        iconSize={20}
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

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: t('profiles.title'),
                    headerBackTitle: t('common.back'),
                }}
            />

            <ItemList style={{ paddingTop: 0 }}>
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
                        {favoriteProfileItems.length > 0 && (
                            <ItemGroup title="Favorites">
                                {favoriteProfileItems.map((profile, index) => {
                                    const isSelected = selectedId === profile.id;
                                    const isLast = index === favoriteProfileItems.length - 1;
                                    return (
		                                        <Item
		                                            key={profile.id}
		                                            title={profile.name}
		                                            subtitle={getProfileSubtitle(profile)}
		                                            icon={renderProfileIcon(profile)}
		                                            onPress={() => setProfileParamAndClose(profile.id)}
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
                            <ItemGroup title="Your AI Profiles">
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
		                                        onPress={() => setProfileParamAndClose(profile.id)}
		                                        showChevron={false}
		                                            selected={isSelected}
	                                            rightElement={renderProfileRowRightElement(profile, isSelected, isFavorite)}
	                                            showDivider={!isLast}
	                                        />
                                    );
                                })}
                            </ItemGroup>
                        )}

                        <ItemGroup title="Built-in AI Profiles">
                            <Item
                                title={t('profiles.noProfile')}
                                subtitle={t('profiles.noProfileDescription')}
                                icon={<Ionicons name="home-outline" size={29} color={theme.colors.textSecondary} />}
                                onPress={() => setProfileParamAndClose('')}
	                                showChevron={false}
	                                selected={selectedId === ''}
	                                rightElement={selectedId === ''
	                                    ? <Ionicons name="checkmark-circle" size={24} color={theme.colors.button.primary.background} />
	                                    : null}
                                showDivider={nonFavoriteBuiltInProfiles.length > 0}
                            />
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
	                                        onPress={() => setProfileParamAndClose(profile.id)}
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
}
