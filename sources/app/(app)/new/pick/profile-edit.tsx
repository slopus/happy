import React from 'react';
import { View, KeyboardAvoidingView, Platform, useWindowDimensions } from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { CommonActions, useNavigation } from '@react-navigation/native';
import { StyleSheet } from 'react-native-unistyles';
import { useUnistyles } from 'react-native-unistyles';
import { useHeaderHeight } from '@react-navigation/elements';
import Constants from 'expo-constants';
import { t } from '@/text';
import { ProfileEditForm } from '@/components/ProfileEditForm';
import { AIBackendProfile } from '@/sync/settings';
import { layout } from '@/components/layout';
import { useSettingMutable } from '@/sync/storage';
import { DEFAULT_PROFILES, getBuiltInProfile } from '@/sync/profileUtils';
import { convertBuiltInProfileToCustom, createEmptyCustomProfile, duplicateProfileForEdit } from '@/sync/profileMutations';
import { Modal } from '@/modal';

export default function ProfileEditScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{
        profileId?: string | string[];
        cloneFromProfileId?: string | string[];
        profileData?: string | string[];
        machineId?: string | string[];
    }>();
    const profileIdParam = Array.isArray(params.profileId) ? params.profileId[0] : params.profileId;
    const cloneFromProfileIdParam = Array.isArray(params.cloneFromProfileId) ? params.cloneFromProfileId[0] : params.cloneFromProfileId;
    const profileDataParam = Array.isArray(params.profileData) ? params.profileData[0] : params.profileData;
    const machineIdParam = Array.isArray(params.machineId) ? params.machineId[0] : params.machineId;
    const screenWidth = useWindowDimensions().width;
    const headerHeight = useHeaderHeight();
    const [profiles, setProfiles] = useSettingMutable('profiles');
    const [, setLastUsedProfile] = useSettingMutable('lastUsedProfile');
    const [isDirty, setIsDirty] = React.useState(false);
    const isDirtyRef = React.useRef(false);

    React.useEffect(() => {
        isDirtyRef.current = isDirty;
    }, [isDirty]);

    // Deserialize profile from URL params
    const profile: AIBackendProfile = React.useMemo(() => {
        if (profileDataParam) {
            try {
                // Params may arrive already decoded (native) or URL-encoded (web / manual encodeURIComponent).
                // Try raw JSON first, then fall back to decodeURIComponent.
                try {
                    return JSON.parse(profileDataParam);
                } catch {
                    return JSON.parse(decodeURIComponent(profileDataParam));
                }
            } catch (error) {
                console.error('Failed to parse profile data:', error);
            }
        }
        const resolveById = (id: string) => profiles.find((p) => p.id === id) ?? getBuiltInProfile(id) ?? null;

        if (cloneFromProfileIdParam) {
            const base = resolveById(cloneFromProfileIdParam);
            if (base) {
                return duplicateProfileForEdit(base);
            }
        }

        if (profileIdParam) {
            const existing = resolveById(profileIdParam);
            if (existing) {
                return existing;
            }
        }

        // Return empty profile for new profile creation
        return createEmptyCustomProfile();
    }, [cloneFromProfileIdParam, profileDataParam, profileIdParam, profiles]);

    const confirmDiscard = React.useCallback(async () => {
        return Modal.confirm(
            'Discard changes?',
            'You have unsaved changes. Discard them?',
            { destructive: true, confirmText: 'Discard', cancelText: 'Keep editing' },
        );
    }, []);

    React.useEffect(() => {
        const subscription = (navigation as any)?.addListener?.('beforeRemove', (e: any) => {
            if (!isDirtyRef.current) return;

            e.preventDefault();

            void (async () => {
                const discard = await confirmDiscard();
                if (discard) {
                    isDirtyRef.current = false;
                    (navigation as any).dispatch(e.data.action);
                }
            })();
        });

        return subscription;
    }, [confirmDiscard, navigation]);

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
        const isNewProfile = existingIndex < 0;
        const updatedProfiles = existingIndex >= 0
            ? profiles.map((p, idx) => idx === existingIndex ? { ...profileToSave, updatedAt: Date.now() } : p)
            : [...profiles, profileToSave];

        setProfiles(updatedProfiles);

        // Update last used profile for convenience in other screens.
        if (isNewProfile) {
            setLastUsedProfile(profileToSave.id);
            // For newly created profiles (including "Save As" from a built-in profile), jump back to /new
            // and pass the id through route params so it can be selected immediately.
            // This avoids relying on intermediate picker screens to forward the selection.
            isDirtyRef.current = false;
            setIsDirty(false);
            router.replace({
                pathname: '/new',
                params: { profileId: profileToSave.id },
            } as any);
            return;
        }

        // Pass selection back to the /new screen via navigation params (unmount-safe).
        const state = (navigation as any).getState?.();
        const previousRoute = state?.routes?.[state.index - 1];
        if (state && state.index > 0 && previousRoute) {
            (navigation as any).dispatch({
                ...CommonActions.setParams({ profileId: profileToSave.id }),
                source: previousRoute.key,
            } as never);
        }
        // Prevent the unsaved-changes guard from triggering on successful save.
        isDirtyRef.current = false;
        setIsDirty(false);
        router.back();
    };

    const handleCancel = React.useCallback(() => {
        void (async () => {
            if (!isDirtyRef.current) {
                router.back();
                return;
            }
            const discard = await confirmDiscard();
            if (discard) {
                isDirtyRef.current = false;
                router.back();
            }
        })();
    }, [confirmDiscard, router]);

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
                        machineId={machineIdParam || null}
                        onSave={handleSave}
                        onCancel={handleCancel}
                        onDirtyChange={setIsDirty}
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
