import React from 'react';
import { View, KeyboardAvoidingView, Platform, useWindowDimensions } from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { useUnistyles } from 'react-native-unistyles';
import { useHeaderHeight } from '@react-navigation/elements';
import Constants from 'expo-constants';
import { t } from '@/text';
import { ProfileEditForm } from '@/components/ProfileEditForm';
import { AIBackendProfile } from '@/sync/settings';
import { layout } from '@/components/layout';
import { callbacks } from '../index';
import { useSettingMutable } from '@/sync/storage';
import { DEFAULT_PROFILES, getBuiltInProfile } from '@/sync/profileUtils';
import { convertBuiltInProfileToCustom } from '@/sync/profileMutations';
import { Modal } from '@/modal';

export default function ProfileEditScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const params = useLocalSearchParams<{ profileData?: string; machineId?: string }>();
    const screenWidth = useWindowDimensions().width;
    const headerHeight = useHeaderHeight();
    const [profiles, setProfiles] = useSettingMutable('profiles');
    const [, setLastUsedProfile] = useSettingMutable('lastUsedProfile');

    // Deserialize profile from URL params
    const profile: AIBackendProfile = React.useMemo(() => {
        if (params.profileData) {
            try {
                // Params may arrive already decoded (native) or URL-encoded (web / manual encodeURIComponent).
                // Try raw JSON first, then fall back to decodeURIComponent.
                try {
                    return JSON.parse(params.profileData);
                } catch {
                    return JSON.parse(decodeURIComponent(params.profileData));
                }
            } catch (error) {
                console.error('Failed to parse profile data:', error);
            }
        }
        // Return empty profile for new profile creation
        return {
            id: '',
            name: '',
            anthropicConfig: {},
            environmentVariables: [],
            compatibility: { claude: true, codex: true },
            isBuiltIn: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            version: '1.0.0',
        };
    }, [params.profileData]);

    const handleSave = (savedProfile: AIBackendProfile) => {
        if (!savedProfile.name || savedProfile.name.trim() === '') {
            Modal.alert(t('common.error'), 'Enter a profile name.');
            return;
        }

        const isBuiltIn =
            savedProfile.isBuiltIn === true ||
            DEFAULT_PROFILES.some((bp) => bp.id === savedProfile.id) ||
            !!getBuiltInProfile(savedProfile.id);

        let profileToSave = savedProfile;
        if (isBuiltIn) {
            profileToSave = convertBuiltInProfileToCustom(savedProfile);
        }

        // Duplicate name guard (same behavior as settings/profiles)
        const isDuplicateName = profiles.some((p) => {
            if (isBuiltIn) {
                return p.name.trim() === profileToSave.name.trim();
            }
            return p.id !== profileToSave.id && p.name.trim() === profileToSave.name.trim();
        });
        if (isDuplicateName) {
            Modal.alert(t('common.error'), 'A profile with that name already exists.');
            return;
        }

        const existingIndex = profiles.findIndex((p) => p.id === profileToSave.id);
        const updatedProfiles = existingIndex >= 0
            ? profiles.map((p, idx) => idx === existingIndex ? { ...profileToSave, updatedAt: Date.now() } : p)
            : [...profiles, profileToSave];

        setProfiles(updatedProfiles);
        setLastUsedProfile(profileToSave.id);

        // Still notify the /new screen in case it is mounted and wants to update selection immediately.
        callbacks.onProfileSaved(profileToSave);
        router.back();
    };

    const handleCancel = () => {
        router.back();
    };

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={Platform.OS === 'ios' ? Constants.statusBarHeight + headerHeight : 0}
            style={profileEditScreenStyles.container}
        >
            <Stack.Screen
                options={{
                    headerTitle: profile.name ? t('profiles.editProfile') : t('profiles.addProfile'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <View style={[
                { flex: 1, paddingHorizontal: screenWidth > 700 ? 16 : 8 }
            ]}>
                <View style={[
                    { maxWidth: layout.maxWidth, flex: 1, width: '100%', alignSelf: 'center' }
                ]}>
                    <ProfileEditForm
                        profile={profile}
                        machineId={params.machineId || null}
                        onSave={handleSave}
                        onCancel={handleCancel}
                    />
                </View>
            </View>
        </KeyboardAvoidingView>
    );
}

const profileEditScreenStyles = StyleSheet.create((theme, rt) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
        paddingTop: rt.insets.top,
        paddingBottom: rt.insets.bottom,
    },
}));
