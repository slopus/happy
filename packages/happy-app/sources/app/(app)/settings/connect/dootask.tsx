/**
 * DooTask Connect Page
 *
 * A form-based login screen for connecting a DooTask account.
 * Supports email/password login with optional captcha verification.
 * On success, saves the DooTask profile to storage and navigates back.
 */

import React from 'react';
import {
    View,
    Text,
    ScrollView,
    TextInput,
    Pressable,
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { useHeaderHeight } from '@react-navigation/elements';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { ItemGroup } from '@/components/ItemGroup';
import { storage } from '@/sync/storage';
import { t } from '@/text';
import { dootaskLogin, dootaskGetTokenExpire } from '@/sync/dootask/api';
import type { DooTaskProfile } from '@/sync/dootask/types';

export default React.memo(function DooTaskConnectPage() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();

    // Form state
    const [serverUrl, setServerUrl] = React.useState('');
    const [email, setEmail] = React.useState('');
    const [password, setPassword] = React.useState('');
    const [code, setCode] = React.useState('');
    const [codeKey, setCodeKey] = React.useState<string | null>(null);

    // UI state
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const canSubmit = React.useMemo(() => {
        return serverUrl.trim().length > 0 && email.trim().length > 0 && password.length > 0;
    }, [serverUrl, email, password]);

    const handleLogin = React.useCallback(async () => {
        if (!canSubmit || loading) return;

        setError(null);
        setLoading(true);

        try {
            // Validate URL format before sending
            const trimmedUrl = serverUrl.trim().replace(/\/+$/, '');
            try {
                const parsed = new URL(trimmedUrl);
                if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && parsed.hostname === 'localhost')) {
                    setError(t('dootask.errorHttpsRequired'));
                    setLoading(false);
                    return;
                }
            } catch {
                setError(t('dootask.errorInvalidUrl'));
                setLoading(false);
                return;
            }

            const result = await dootaskLogin({
                serverUrl: trimmedUrl,
                email: email.trim(),
                password,
                code: codeKey ? code : undefined,
                codeKey: codeKey ?? undefined,
            });

            switch (result.type) {
                case 'success': {
                    // Fetch token expiry info
                    let tokenExpiredAt: string | null = null;
                    let tokenRemainingSeconds: number | null = null;
                    try {
                        const expireRes = await dootaskGetTokenExpire(trimmedUrl, result.token);
                        if (expireRes.ret === 1 && expireRes.data) {
                            tokenExpiredAt = expireRes.data.expired_at ?? null;
                            tokenRemainingSeconds = expireRes.data.remaining_seconds ?? null;
                        }
                    } catch {
                        // Non-critical, proceed without expiry info
                    }

                    const profile: DooTaskProfile = {
                        serverUrl: trimmedUrl,
                        token: result.token,
                        userId: result.userId,
                        username: result.username,
                        avatar: result.avatar,
                        tokenExpiredAt,
                        tokenRemainingSeconds,
                        lastCheckedAt: new Date().toISOString(),
                    };

                    storage.getState().setDootaskProfile(profile);
                    router.back();
                    break;
                }

                case 'captcha_required': {
                    setCodeKey(result.codeKey);
                    setCode('');
                    setError(result.message || t('dootask.captchaRequired'));
                    break;
                }

                case 'token_expired': {
                    setError(result.message || t('dootask.tokenExpired'));
                    break;
                }

                case 'error': {
                    setError(result.message || t('dootask.loginFailed'));
                    break;
                }
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : t('errors.unknownError'));
        } finally {
            setLoading(false);
        }
    }, [canSubmit, loading, serverUrl, email, password, code, codeKey, router]);

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={Platform.OS === 'ios' ? Constants.statusBarHeight + headerHeight : 0}
        >
            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={[styles.scrollContent, { paddingBottom: safeArea.bottom + 24 }]}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            >
                {/* Server URL */}
                <ItemGroup title={t('dootask.serverUrl')}>
                    <View style={styles.inputWrapper}>
                        <TextInput
                            style={styles.input}
                            value={serverUrl}
                            onChangeText={setServerUrl}
                            placeholder="https://your-dootask-server.com"
                            placeholderTextColor={theme.colors.textSecondary}
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="url"
                            textContentType="URL"
                            returnKeyType="next"
                        />
                    </View>
                </ItemGroup>

                {/* Email */}
                <ItemGroup title={t('dootask.email')}>
                    <View style={styles.inputWrapper}>
                        <TextInput
                            style={styles.input}
                            value={email}
                            onChangeText={setEmail}
                            placeholder="your@email.com"
                            placeholderTextColor={theme.colors.textSecondary}
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="email-address"
                            textContentType="emailAddress"
                            returnKeyType="next"
                        />
                    </View>
                </ItemGroup>

                {/* Password */}
                <ItemGroup title={t('dootask.password')}>
                    <View style={styles.inputWrapper}>
                        <TextInput
                            style={styles.input}
                            value={password}
                            onChangeText={setPassword}
                            placeholder={t('dootask.password')}
                            placeholderTextColor={theme.colors.textSecondary}
                            autoCapitalize="none"
                            autoCorrect={false}
                            secureTextEntry
                            textContentType="password"
                            returnKeyType={codeKey ? 'next' : 'go'}
                            onSubmitEditing={codeKey ? undefined : handleLogin}
                        />
                    </View>
                </ItemGroup>

                {/* Captcha Code (conditional) */}
                {codeKey && (
                    <ItemGroup title={t('dootask.captchaRequired')}>
                        <View style={styles.inputWrapper}>
                            <TextInput
                                style={styles.input}
                                value={code}
                                onChangeText={setCode}
                                placeholder={t('dootask.captchaPlaceholder')}
                                placeholderTextColor={theme.colors.textSecondary}
                                autoCapitalize="none"
                                autoCorrect={false}
                                keyboardType="default"
                                returnKeyType="go"
                                onSubmitEditing={handleLogin}
                            />
                        </View>
                    </ItemGroup>
                )}

                {/* Error Message */}
                {error && (
                    <View style={styles.errorContainer}>
                        <Text style={styles.errorText}>{error}</Text>
                    </View>
                )}

                {/* Submit Button */}
                <Pressable
                    style={[styles.submitButton, (!canSubmit || loading) && styles.submitButtonDisabled]}
                    onPress={handleLogin}
                    disabled={!canSubmit || loading}
                >
                    {loading ? (
                        <ActivityIndicator color={theme.colors.button.primary.tint} />
                    ) : (
                        <Text style={styles.submitButtonText}>{t('dootask.connect')}</Text>
                    )}
                </Pressable>
            </ScrollView>
        </KeyboardAvoidingView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    scrollView: {
        flex: 1,
    },
    scrollContent: {
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
    },
    inputWrapper: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        overflow: 'hidden',
    },
    input: {
        borderRadius: 16,
        paddingHorizontal: 16,
        paddingVertical: 12,
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default(),
    },
    errorContainer: {
        marginHorizontal: 16,
        marginTop: 12,
    },
    errorText: {
        fontSize: 14,
        color: theme.colors.textDestructive,
        textAlign: 'center',
        ...Typography.default(),
    },
    submitButton: {
        backgroundColor: theme.colors.button.primary.background,
        marginHorizontal: 16,
        marginTop: 24,
        paddingVertical: 14,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        height: 50,
    },
    submitButtonDisabled: {
        opacity: 0.5,
    },
    submitButtonText: {
        color: theme.colors.button.primary.tint,
        fontSize: 17,
        ...Typography.default('semiBold'),
    },
}));
