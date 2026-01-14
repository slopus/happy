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
import { getBuiltInProfile, DEFAULT_PROFILES, getProfilePrimaryCli } from '@/sync/profileUtils';
import { useUnistyles } from 'react-native-unistyles';
import { randomUUID } from 'expo-crypto';
import { AIBackendProfile } from '@/sync/settings';
import { Modal } from '@/modal';

export default function ProfilePickerScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{ selectedId?: string; machineId?: string }>();
    const useProfiles = useSetting('useProfiles');
    const [profiles, setProfiles] = useSettingMutable('profiles');

    const selectedId = typeof params.selectedId === 'string' ? params.selectedId : '';
    const machineId = typeof params.machineId === 'string' ? params.machineId : undefined;

    const renderProfileIcon = React.useCallback((profile: AIBackendProfile) => {
        const primary = getProfilePrimaryCli(profile);
        const iconName =
            primary === 'claude' ? 'cloud-outline' :
                primary === 'codex' ? 'terminal-outline' :
                    primary === 'gemini' ? 'planet-outline' :
                        primary === 'multi' ? 'sparkles-outline' :
                            'person-outline';
        return (
            <Ionicons name={iconName as any} size={29} color={theme.colors.textSecondary} />
        );
    }, [theme.colors.textSecondary]);

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

    const openProfileEdit = React.useCallback((profile: AIBackendProfile) => {
        const profileData = JSON.stringify(profile);
        const base = `/new/pick/profile-edit?profileData=${encodeURIComponent(profileData)}`;
        router.push(machineId ? `${base}&machineId=${encodeURIComponent(machineId)}` as any : base as any);
    }, [machineId, router]);

    const handleAddProfile = React.useCallback(() => {
        const newProfile: AIBackendProfile = {
            id: randomUUID(),
            name: '',
            anthropicConfig: {},
            environmentVariables: [],
            compatibility: { claude: true, codex: true, gemini: true },
            isBuiltIn: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            version: '1.0.0',
        };
        openProfileEdit(newProfile);
    }, [openProfileEdit]);

    const handleDuplicateProfile = React.useCallback((profile: AIBackendProfile) => {
        const duplicated: AIBackendProfile = {
            ...profile,
            id: randomUUID(),
            name: `${profile.name} (Copy)`,
            isBuiltIn: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        openProfileEdit(duplicated);
    }, [openProfileEdit]);

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
                        <ItemGroup>
                            <Item
                                title={t('profiles.addProfile')}
                                icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.button.secondary.tint} />}
                                onPress={handleAddProfile}
                                showChevron={false}
                            />
                        </ItemGroup>

                        <ItemGroup footer={t('profiles.subtitle')}>
                            <Item
                                title={t('profiles.noProfile')}
                                subtitle={t('profiles.noProfileDescription')}
                                icon={<Ionicons name="settings-outline" size={29} color={theme.colors.textSecondary} />}
                                onPress={() => setProfileParamAndClose('')}
                                showChevron={false}
                                selected={selectedId === ''}
                                pressableStyle={selectedId === '' ? { backgroundColor: theme.colors.surfaceSelected } : undefined}
                                rightElement={selectedId === ''
                                    ? <Ionicons name="checkmark-circle" size={24} color={theme.colors.button.primary.background} />
                                    : null}
                            />
                        </ItemGroup>

                        <ItemGroup>
                            {DEFAULT_PROFILES.map((profileDisplay) => {
                                const profile = getBuiltInProfile(profileDisplay.id);
                                if (!profile) return null;

                                const isSelected = selectedId === profile.id;
                                return (
                                    <Item
                                        key={profile.id}
                                        title={profile.name}
                                        subtitle={t('profiles.defaultModel')}
                                        icon={renderProfileIcon(profile)}
                                        onPress={() => setProfileParamAndClose(profile.id)}
                                        showChevron={false}
                                        selected={isSelected}
                                        pressableStyle={isSelected ? { backgroundColor: theme.colors.surfaceSelected } : undefined}
                                        rightElement={
                                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                                {isSelected && (
                                                    <Ionicons
                                                        name="checkmark-circle"
                                                        size={24}
                                                        color={theme.colors.button.primary.background}
                                                        style={{ marginRight: 12 }}
                                                    />
                                                )}
                                                <Pressable
                                                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                                    onPress={(e) => {
                                                        e.stopPropagation();
                                                        openProfileEdit(profile);
                                                    }}
                                                >
                                                    <Ionicons name="create-outline" size={20} color={theme.colors.button.secondary.tint} />
                                                </Pressable>
                                                <Pressable
                                                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                                    onPress={(e) => {
                                                        e.stopPropagation();
                                                        handleDuplicateProfile(profile);
                                                    }}
                                                    style={{ marginLeft: 16 }}
                                                >
                                                    <Ionicons name="copy-outline" size={20} color={theme.colors.button.secondary.tint} />
                                                </Pressable>
                                            </View>
                                        }
                                    />
                                );
                            })}

                            {profiles.map((profile) => {
                                const isSelected = selectedId === profile.id;
                                return (
                                    <Item
                                        key={profile.id}
                                        title={profile.name}
                                        subtitle={t('profiles.defaultModel')}
                                        icon={renderProfileIcon(profile)}
                                        onPress={() => setProfileParamAndClose(profile.id)}
                                        showChevron={false}
                                        selected={isSelected}
                                        pressableStyle={isSelected ? { backgroundColor: theme.colors.surfaceSelected } : undefined}
                                        rightElement={
                                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                                {isSelected && (
                                                    <Ionicons
                                                        name="checkmark-circle"
                                                        size={24}
                                                        color={theme.colors.button.primary.background}
                                                        style={{ marginRight: 12 }}
                                                    />
                                                )}
                                                <Pressable
                                                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                                    onPress={(e) => {
                                                        e.stopPropagation();
                                                        openProfileEdit(profile);
                                                    }}
                                                >
                                                    <Ionicons name="create-outline" size={20} color={theme.colors.button.secondary.tint} />
                                                </Pressable>
                                                <Pressable
                                                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                                    onPress={(e) => {
                                                        e.stopPropagation();
                                                        handleDuplicateProfile(profile);
                                                    }}
                                                    style={{ marginLeft: 16 }}
                                                >
                                                    <Ionicons name="copy-outline" size={20} color={theme.colors.button.secondary.tint} />
                                                </Pressable>
                                                <Pressable
                                                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                                    onPress={(e) => {
                                                        e.stopPropagation();
                                                        handleDeleteProfile(profile);
                                                    }}
                                                    style={{ marginLeft: 16 }}
                                                >
                                                    <Ionicons name="trash-outline" size={20} color={theme.colors.deleteAction} />
                                                </Pressable>
                                            </View>
                                        }
                                    />
                                );
                            })}
                        </ItemGroup>
                    </>
                )}
            </ItemList>
        </>
    );
}
