import React, { useState } from 'react';
import { Platform, View, Text, TextInput, ScrollView, KeyboardAvoidingView } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { RoundButton } from '@/components/RoundButton';
import { Typography } from '@/constants/Typography';
import { normalizeSecretKey } from '@/auth/secretKeyBackup';
import { authGetToken } from '@/auth/authGetToken';
import { decodeBase64 } from '@/encryption/base64';
import { layout } from '@/components/layout';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

const stylesheet = StyleSheet.create((theme) => ({
    keyboardAvoidingView: {
        flex: 1,
    },
    scrollView: {
        flex: 1,
        backgroundColor: Platform.select({ web: theme.colors.surface, default: 'transparent' }),
    },
    container: {
        flexGrow: 1,
        alignItems: 'center',
        paddingHorizontal: 24,
    },
    contentWrapper: {
        width: '100%',
        maxWidth: layout.maxWidth,
        paddingVertical: 24,
    },
    instruction: {
        ...Typography.default(),
        fontSize: 17,
        lineHeight: 22,
        color: theme.colors.textSecondary,
        marginBottom: 20,
    },
    textInput: {
        backgroundColor: Platform.select({ web: theme.colors.input.background, default: theme.colors.surfaceHigh }),
        padding: 16,
        borderRadius: 12,
        fontFamily: 'IBMPlexMono-Regular',
        fontSize: 15,
        lineHeight: 22,
        minHeight: 120,
        textAlignVertical: 'top',
        color: theme.colors.input.text,
        marginBottom: 24,
    },
}));

export default function Restore() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const auth = useAuth();
    const router = useRouter();
    const [restoreKey, setRestoreKey] = useState('');

    const handleRestore = async () => {
        const trimmedKey = restoreKey.trim();

        if (!trimmedKey) {
            Modal.alert(t('common.error'), t('connect.enterSecretKey'));
            return;
        }

        try {
            // Normalize the key (handles both base64url and formatted input)
            const normalizedKey = normalizeSecretKey(trimmedKey);

            // Validate the secret key format
            const secretBytes = decodeBase64(normalizedKey, 'base64url');
            if (secretBytes.length !== 32) {
                throw new Error('Invalid secret key length');
            }

            // Get token from secret
            const token = await authGetToken(secretBytes);
            if (!token) {
                throw new Error('Failed to authenticate with provided key');
            }

            // Login with new credentials
            await auth.login(token, normalizedKey);

            // Straight home. A plain back() landed on the QR restore screen
            // underneath, which then restarted its own pairing.
            router.dismissTo('/');

        } catch (error) {
            console.error('Restore error:', error);
            Modal.alert(t('common.error'), t('connect.invalidSecretKey'));
        }
    };

    return (
        <KeyboardAvoidingView
            style={styles.keyboardAvoidingView}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.container}
                keyboardShouldPersistTaps="handled"
            >
                <View style={styles.contentWrapper}>
                    <Text style={styles.instruction}>{t('onboarding.secretKeyBody')}</Text>

                    <TextInput
                        style={styles.textInput}
                        placeholder="XXXXX-XXXXX-XXXXX..."
                        placeholderTextColor={theme.colors.input.placeholder}
                        value={restoreKey}
                        onChangeText={setRestoreKey}
                        autoCapitalize="characters"
                        autoCorrect={false}
                        autoFocus
                        multiline={true}
                        numberOfLines={4}
                    />

                    <RoundButton
                        title={t('onboarding.restoreButton')}
                        action={handleRestore}
                    />
                </View>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}
