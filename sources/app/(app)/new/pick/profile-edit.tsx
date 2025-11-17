import React from 'react';
import { View } from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { ProfileEditForm } from '@/components/ProfileEditForm';
import { AIBackendProfile } from '@/sync/settings';
import { callbacks } from '../index';

export default function ProfileEditScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const params = useLocalSearchParams<{ profileData?: string }>();

    // Deserialize profile from URL params
    const profile: AIBackendProfile = React.useMemo(() => {
        if (params.profileData) {
            try {
                return JSON.parse(decodeURIComponent(params.profileData));
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
        // Call the callback to notify wizard of saved profile
        callbacks.onProfileSaved(savedProfile);
        router.back();
    };

    const handleCancel = () => {
        router.back();
    };

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
            <Stack.Screen
                options={{
                    headerTitle: profile.name ? t('profiles.editProfile') : t('profiles.addProfile'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <ProfileEditForm
                profile={profile}
                onSave={handleSave}
                onCancel={handleCancel}
            />
        </View>
    );
}
