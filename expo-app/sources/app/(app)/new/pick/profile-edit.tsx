import React from 'react';
import { View, KeyboardAvoidingView, Platform, useWindowDimensions, Pressable } from 'react-native';
import { Stack, useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { useUnistyles } from 'react-native-unistyles';
import { useHeaderHeight } from '@react-navigation/elements';
import Constants from 'expo-constants';
import { t } from '@/text';
import { ProfileEditForm } from '@/components/profiles/edit';
import { AIBackendProfile } from '@/sync/settings';
import { layout } from '@/components/layout';
import { useSettingMutable } from '@/sync/storage';
import { DEFAULT_PROFILES, getBuiltInProfile, getBuiltInProfileNameKey, resolveProfileById } from '@/sync/profileUtils';
import { convertBuiltInProfileToCustom, createEmptyCustomProfile, duplicateProfileForEdit } from '@/sync/profileMutations';
import { Modal } from '@/modal';
import { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';
import { Ionicons } from '@expo/vector-icons';
import { PopoverPortalTargetProvider } from '@/components/ui/popover';

export default React.memo(function ProfileEditScreen() {
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
    const saveRef = React.useRef<(() => boolean) | null>(null);

    React.useEffect(() => {
        isDirtyRef.current = isDirty;
    }, [isDirty]);

    React.useEffect(() => {
        // On iOS native-stack modals, swipe-down dismissal can bypass `beforeRemove` in practice.
        // The only reliable way to ensure unsaved edits aren't lost is to disable the gesture
        // while the form is dirty, and rely on the header back/cancel flow (which we guard).
        const setOptions = (navigation as any)?.setOptions;
        if (typeof setOptions !== 'function') return;
        setOptions({ gestureEnabled: !isDirty });
    }, [isDirty, navigation]);

    React.useEffect(() => {
        const setOptions = (navigation as any)?.setOptions;
        if (typeof setOptions !== 'function') return;
        return () => {
            // Always re-enable the gesture when leaving this screen.
            setOptions({ gestureEnabled: true });
        };
    }, [navigation]);

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
        const resolveById = (id: string) => resolveProfileById(id, profiles);

        if (cloneFromProfileIdParam) {
            const base = resolveById(cloneFromProfileIdParam);
            if (base) {
                return duplicateProfileForEdit(base, { copySuffix: t('profiles.copySuffix') });
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
        const saveText = profile.isBuiltIn ? t('common.saveAs') : t('common.save');
        const message = profile.isBuiltIn
            ? `${t('common.unsavedChangesWarning')}\n\n${t('profiles.builtInSaveAsHint')}`
            : t('common.unsavedChangesWarning');
        return promptUnsavedChangesAlert(
            (title, message, buttons) => Modal.alert(title, message, buttons),
            {
                title: t('common.discardChanges'),
                message,
                discardText: t('common.discard'),
                saveText,
                keepEditingText: t('common.keepEditing'),
            },
        );
    }, [profile.isBuiltIn]);

    React.useEffect(() => {
        const addListener = (navigation as any)?.addListener;
        if (typeof addListener !== 'function') {
            return;
        }

        const subscription = addListener.call(navigation, 'beforeRemove', (e: any) => {
            if (!isDirtyRef.current) return;

            e.preventDefault();

            void (async () => {
                const decision = await confirmDiscard();
                if (decision === 'discard') {
                    isDirtyRef.current = false;
                    (navigation as any).dispatch(e.data.action);
                } else if (decision === 'save') {
                    saveRef.current?.();
                }
            })();
        });

        return () => subscription?.remove?.();
    }, [confirmDiscard, navigation]);

    const handleSave = (savedProfile: AIBackendProfile): boolean => {
        if (!savedProfile.name || savedProfile.name.trim() === '') {
            Modal.alert(t('common.error'), t('profiles.nameRequired'));
            return false;
        }

        const isBuiltIn =
            savedProfile.isBuiltIn === true ||
            DEFAULT_PROFILES.some((bp) => bp.id === savedProfile.id) ||
            getBuiltInProfileNameKey(savedProfile.id) !== null;

        let profileToSave = savedProfile;
        if (isBuiltIn) {
            profileToSave = convertBuiltInProfileToCustom(savedProfile);
        }

        const builtInNames = DEFAULT_PROFILES
            .map((bp) => {
                const key = getBuiltInProfileNameKey(bp.id);
                return key ? t(key).trim() : null;
            })
            .filter((name): name is string => Boolean(name));
        const hasBuiltInNameConflict = builtInNames.includes(profileToSave.name.trim());

        // Duplicate name guard (same behavior as settings/profiles)
        const isDuplicateName = profiles.some((p) => {
            if (isBuiltIn) {
                return p.name.trim() === profileToSave.name.trim();
            }
            return p.id !== profileToSave.id && p.name.trim() === profileToSave.name.trim();
        });
        if (isDuplicateName || hasBuiltInNameConflict) {
            Modal.alert(t('common.error'), t('profiles.duplicateName'));
            return false;
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
            // For newly created profiles (including "Save As" from a built-in profile), prefer passing the id
            // back to the previous picker route (if present). The picker already knows how to forward the
            // selection to /new and close itself. This avoids stacking /new on top of /new (wizard case).
            isDirtyRef.current = false;
            setIsDirty(false);
            const state = (navigation as any).getState?.();
            const previousRoute = state?.routes?.[state.index - 1];
            if (state && state.index > 0 && previousRoute) {
                (navigation as any).dispatch({
                    type: 'SET_PARAMS',
                    payload: { params: { profileId: profileToSave.id } },
                    source: previousRoute.key,
                } as never);
                router.back();
                return true;
            }

            // Fallback: if we can't find a previous route to set params on, go to /new directly.
            router.replace({
                pathname: '/new',
                params: { profileId: profileToSave.id },
            } as any);
            return true;
        }

        // Pass selection back to the /new screen via navigation params (unmount-safe).
        const state = (navigation as any).getState?.();
        const previousRoute = state?.routes?.[state.index - 1];
        if (state && state.index > 0 && previousRoute) {
            (navigation as any).dispatch({
                type: 'SET_PARAMS',
                payload: { params: { profileId: profileToSave.id } },
                source: previousRoute.key,
            } as never);
        }
        // Prevent the unsaved-changes guard from triggering on successful save.
        isDirtyRef.current = false;
        setIsDirty(false);
        router.back();
        return true;
    };

    const handleCancel = React.useCallback(() => {
        void (async () => {
            if (!isDirtyRef.current) {
                router.back();
                return;
            }
            const decision = await confirmDiscard();
            if (decision === 'discard') {
                isDirtyRef.current = false;
                router.back();
            } else if (decision === 'save') {
                saveRef.current?.();
            }
        })();
    }, [confirmDiscard, router]);

    const headerTitle = profile.name ? t('profiles.editProfile') : t('profiles.addProfile');
    const headerBackTitle = t('common.back');

    const headerLeft = React.useCallback(() => {
        return (
            <Pressable
                onPress={handleCancel}
                accessibilityRole="button"
                accessibilityLabel={t('common.cancel')}
                hitSlop={12}
                style={({ pressed }) => ({
                    opacity: pressed ? 0.7 : 1,
                    padding: 4,
                })}
            >
                <Ionicons name="close" size={24} color={theme.colors.header.tint} />
            </Pressable>
        );
    }, [handleCancel, theme.colors.header.tint]);

    const handleSavePress = React.useCallback(() => {
        saveRef.current?.();
    }, []);

    const headerRight = React.useCallback(() => {
        return (
            <Pressable
                onPress={handleSavePress}
                disabled={!isDirty}
                accessibilityRole="button"
                accessibilityLabel={t('common.save')}
                hitSlop={12}
                style={({ pressed }) => ({
                    opacity: !isDirty ? 0.35 : pressed ? 0.7 : 1,
                    padding: 4,
                })}
            >
                <Ionicons name="checkmark" size={24} color={theme.colors.header.tint} />
            </Pressable>
        );
    }, [handleSavePress, isDirty, theme.colors.header.tint]);

    const screenOptions = React.useMemo(() => {
        return {
            headerTitle,
            headerBackTitle,
            headerLeft,
            headerRight,
        } as const;
    }, [headerBackTitle, headerLeft, headerRight, headerTitle]);

    return (
        <PopoverPortalTargetProvider>
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                keyboardVerticalOffset={Platform.OS === 'ios' ? Constants.statusBarHeight + headerHeight : 0}
                style={profileEditScreenStyles.container}
            >
                <Stack.Screen
                    options={screenOptions}
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
                            saveRef={saveRef}
                        />
                    </View>
                </View>
            </KeyboardAvoidingView>
        </PopoverPortalTargetProvider>
    );
});

const profileEditScreenStyles = StyleSheet.create((theme, rt) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
        paddingBottom: rt.insets.bottom,
    },
}));
