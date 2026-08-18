import * as React from 'react';
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    Text,
    TextInput,
    View,
} from 'react-native';
import { Stack } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { ProfileAvatarControl } from '@/components/ProfileAvatarControl';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { Modal } from '@/modal';
import { updateAccountProfile } from '@/sync/apiAccount';
import { getDisplayName } from '@/sync/profile';
import { useProfile } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { useSettingsRouter } from '@/components/DesktopSettingsNavigation';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    scrollContent: {
        flexGrow: 1,
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingTop: 32,
        paddingBottom: 40,
    },
    content: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignItems: 'center',
    },
    avatarWrap: {
        marginBottom: 58,
    },
    formCard: {
        width: '100%',
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        paddingHorizontal: 20,
        paddingVertical: 18,
    },
    fieldLabel: {
        ...Typography.default('regular'),
        color: theme.colors.text,
        fontSize: 17,
        lineHeight: 24,
        marginBottom: 12,
    },
    textInput: {
        ...Typography.default('regular'),
        color: theme.colors.text,
        fontSize: 20,
        lineHeight: 28,
        minHeight: 36,
        padding: 0,
    },
    saveButton: {
        minWidth: 68,
        height: 36,
        paddingHorizontal: 16,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.button.primary.background,
    },
    saveButtonDisabled: {
        opacity: 0.45,
    },
    saveButtonText: {
        ...Typography.default('semiBold'),
        color: theme.colors.button.primary.tint,
        fontSize: 17,
        lineHeight: 22,
    },
}));

export default function ProfileSettingsScreen() {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useSettingsRouter();
    const auth = useAuth();
    const profile = useProfile();
    const currentName = getDisplayName(profile) ?? '';
    const [name, setName] = React.useState(currentName);
    const [saving, setSaving] = React.useState(false);

    React.useEffect(() => {
        setName(currentName);
    }, [currentName]);

    const trimmedName = name.trim();
    const hasChanges = trimmedName !== currentName.trim();
    const canSave = hasChanges && trimmedName.length > 0 && !saving;

    const handleSave = React.useCallback(async () => {
        if (!auth.credentials || saving) {
            return;
        }
        if (!trimmedName) {
            Modal.alert(t('common.error'), t('settingsAccount.nameRequired'));
            return;
        }

        setSaving(true);
        try {
            await updateAccountProfile(auth.credentials, { name: trimmedName });
            await sync.refreshProfile();
            router.back();
        } catch (error) {
            Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('settingsAccount.profileSaveFailed'),
            );
        } finally {
            setSaving(false);
        }
    }, [auth.credentials, router, saving, trimmedName]);

    const HeaderRight = React.useCallback(() => (
        <Pressable
            onPress={handleSave}
            disabled={!canSave}
            accessibilityRole="button"
            accessibilityLabel={t('common.save')}
            aria-busy={saving}
            style={[styles.saveButton, !canSave && styles.saveButtonDisabled]}
        >
            {saving ? (
                <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
            ) : (
                <Text style={styles.saveButtonText}>{t('common.save')}</Text>
            )}
        </Pressable>
    ), [canSave, handleSave, saving, styles.saveButton, styles.saveButtonDisabled, styles.saveButtonText, theme.colors.button.primary.tint]);

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.root}
        >
            <Stack.Screen
                options={{
                    headerTitle: t('settingsAccount.editProfile'),
                    headerRight: HeaderRight,
                }}
            />
            <ScrollView
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.scrollContent}
            >
                <View style={styles.content}>
                    <ProfileAvatarControl
                        profile={profile}
                        size={122}
                        style={styles.avatarWrap}
                    />
                    <View style={styles.formCard}>
                        <Text style={styles.fieldLabel}>{t('settingsAccount.name')}</Text>
                        <TextInput
                            value={name}
                            onChangeText={setName}
                            accessibilityLabel={t('settingsAccount.name')}
                            placeholder={t('settingsAccount.namePlaceholder')}
                            placeholderTextColor={theme.colors.textSecondary}
                            style={styles.textInput}
                            maxLength={80}
                            returnKeyType="done"
                            onSubmitEditing={canSave ? handleSave : undefined}
                        />
                    </View>
                </View>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}
