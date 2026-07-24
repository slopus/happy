import React, { useState, useEffect, useRef } from 'react';
import { Platform, View, Text, TextInput, ScrollView, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { RoundButton } from '@/components/RoundButton';
import { Typography } from '@/constants/Typography';
import { normalizeSecretKey } from '@/auth/secretKeyBackup';
import { authGetToken } from '@/auth/authGetToken';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { generateAuthKeyPair, authQRStart, QRAuthKeyPair } from '@/auth/authQRStart';
import { authQRWait } from '@/auth/authQRWait';
import { layout } from '@/components/layout';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { QRCode } from '@/components/qr/QRCode';
import { MobileGlassSurface } from '@/components/MobileGlass';

const stylesheet = StyleSheet.create((theme) => ({
    scrollView: {
        flex: 1,
        backgroundColor: Platform.select({ web: theme.colors.surface, default: 'transparent' }),
    },
    container: {
        flex: 1,
        alignItems: 'center',
        paddingHorizontal: 24,
    },
    contentWrapper: {
        width: '100%',
        maxWidth: layout.maxWidth,
        paddingVertical: 24,
    },
    instructionText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        marginBottom: 20,
        ...Typography.default(),
    },
    secondInstructionText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        marginBottom: 20,
        marginTop: 30,
        ...Typography.default(),
    },
    qrInstructions: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginBottom: 16,
        lineHeight: 22,
        textAlign: 'center',
        ...Typography.default(),
    },
    textInput: {
        backgroundColor: Platform.select({ web: theme.colors.input.background, default: 'transparent' }),
        padding: 16,
        borderRadius: 8,
        fontFamily: 'IBMPlexMono-Regular',
        fontSize: 14,
        minHeight: 120,
        textAlignVertical: 'top',
        color: theme.colors.input.text,
    },
    inputGlass: {
        borderRadius: 16,
        overflow: 'hidden',
        backgroundColor: Platform.select({ web: 'transparent', android: theme.colors.glass.backgroundStrong, default: 'transparent' }),
        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
        borderColor: theme.colors.glass.border,
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

            // Dismiss
            router.back();

        } catch (error) {
            console.error('Restore error:', error);
            Modal.alert(t('common.error'), t('connect.invalidSecretKey'));
        }
    };

    return (
        <ScrollView style={styles.scrollView}>
            <View style={styles.container}>
                <View style={styles.contentWrapper}>
                    <Text style={styles.instructionText}>
                        Enter your secret key to restore access to your account.
                    </Text>

                    <MobileGlassSurface enabled={Platform.OS !== 'web'} intensity={68} style={styles.inputGlass}>
                    <TextInput
                        style={styles.textInput}
                        placeholder="XXXXX-XXXXX-XXXXX..."
                        placeholderTextColor={theme.colors.input.placeholder}
                        value={restoreKey}
                        onChangeText={setRestoreKey}
                        autoCapitalize="characters"
                        autoCorrect={false}
                        multiline={true}
                        numberOfLines={4}
                    />
                    </MobileGlassSurface>

                    <RoundButton
                        title={t('connect.restoreAccount')}
                        action={handleRestore}
                    />
                </View>
            </View>
        </ScrollView>
    );
}
