import React, { useRef, useState } from 'react';
import { View, Text, TextInput, ScrollView } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
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
import { hasServiceAuthorizationLogin, parseServiceAuthorizationLogin, serviceAuthorizationReturnPath } from '@/auth/serviceAuthorizationLogin';

const stylesheet = StyleSheet.create((theme) => ({
    scrollView: {
        flex: 1,
        backgroundColor: theme.colors.surface,
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
    textInput: {
        backgroundColor: theme.colors.input.background,
        padding: 16,
        borderRadius: 8,
        marginBottom: 24,
        ...Typography.mono(),
        fontSize: 14,
        minHeight: 56,
        textAlignVertical: 'top',
        color: theme.colors.input.text,
    },
}));

export default function Restore() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const auth = useAuth();
    const router = useRouter();
    const params = useLocalSearchParams();
    const serviceLogin = parseServiceAuthorizationLogin(params);
    const serviceLoginRequested = hasServiceAuthorizationLogin(params);
    const returnPath = serviceAuthorizationReturnPath(serviceLogin);
    const [restoreKey, setRestoreKey] = useState('');
    const restoreInFlightRef = useRef(false);
    const cancelledRef = useRef(false);
    const loginGeneration = useRef(0);
    const loginAbortRef = useRef<AbortController | null>(null);

    useFocusEffect(React.useCallback(() => {
        loginGeneration.current++; cancelledRef.current = false; restoreInFlightRef.current = false;
        const abort = new AbortController(); loginAbortRef.current = abort;
        return () => { loginGeneration.current++; cancelledRef.current = true; abort.abort(); };
    }, [params.serviceAuthorizationId, params.serviceAuthorizationProtocol, params.serviceAuthorizationStartedAt]));

    useFocusEffect(React.useCallback(() => {
        if (auth.isAuthenticated && (!serviceLoginRequested || returnPath)) {
            router.replace((returnPath ?? '/') as never);
        }
    }, [auth.isAuthenticated, router, serviceLoginRequested, returnPath]));

    const handleRestore = async () => {
        if (restoreInFlightRef.current) {
            return;
        }
        if (serviceLoginRequested && !serviceAuthorizationReturnPath(serviceLogin)) {
            Modal.alert(t('common.error'), '授权链接已过期或无效。请回原应用重新连接。');
            return;
        }

        const trimmedKey = restoreKey.trim();

        if (!trimmedKey) {
            Modal.alert(t('common.error'), t('connect.enterSecretKey'));
            return;
        }

        restoreInFlightRef.current = true;
        const generation = loginGeneration.current;
        const isCurrent = () => !cancelledRef.current && generation === loginGeneration.current;
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
            if (!isCurrent()) return;
            if (!token) {
                throw new Error('Failed to authenticate with provided key');
            }
            if (serviceLoginRequested && !serviceAuthorizationReturnPath(serviceLogin)) {
                Modal.alert(t('common.error'), '授权链接已过期或无效。请回原应用重新连接。');
                return;
            }

            // Login with new credentials
            if (serviceLogin) await auth.login(token, normalizedKey, { serviceAuthorization: serviceLogin, signal: loginAbortRef.current!.signal });
            else await auth.login(token, normalizedKey);

            // Match AuthContext's reload destination; a service login returns to
            // its consent page, while an ordinary restore still opens home.
            if (isCurrent()) router.replace((serviceAuthorizationReturnPath(serviceLogin) ?? '/') as never);

        } catch (error) {
            if (!isCurrent()) return;
            console.error('Restore error:', error);
            Modal.alert(t('common.error'), t('connect.invalidSecretKey'));
        } finally {
            if (generation === loginGeneration.current) restoreInFlightRef.current = false;
        }
    };

    if (serviceLoginRequested && !returnPath) return <View style={styles.container}>
        <Text style={styles.instructionText}>授权链接已过期或无效。请回原应用重新连接。</Text>
        <RoundButton title="返回 Paws" onPress={() => router.replace('/')} />
    </View>;

    return (
        <ScrollView style={styles.scrollView}>
            <View style={styles.container}>
                <View style={styles.contentWrapper}>
                    <Text style={styles.instructionText}>
                        Enter your secret key to restore access to your account.
                    </Text>

                    <TextInput
                        style={styles.textInput}
                        placeholder="XXXXX-XXXXX-XXXXX..."
                        placeholderTextColor={theme.colors.input.placeholder}
                        value={restoreKey}
                        onChangeText={setRestoreKey}
                        autoCapitalize="characters"
                        autoCorrect={false}
                        secureTextEntry={true}
                        multiline={false}
                        accessibilityLabel={t('settingsAccount.secretKey')}
                        testID="restore-secret-key-input"
                    />

                    <RoundButton
                        title={t('connect.restoreAccount')}
                        action={handleRestore}
                    />
                    {serviceLogin ? <RoundButton title="取消登录" display="inverted" onPress={() => {
                        cancelledRef.current = true;
                        loginAbortRef.current?.abort();
                        router.replace((returnPath ?? '/') as never);
                    }} /> : null}
                </View>
            </View>
        </ScrollView>
    );
}
