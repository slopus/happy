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
    Image,
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
import { loadDooTaskLoginCache, saveDooTaskLoginCache } from '@/sync/persistence';
import { t } from '@/text';
import { dootaskLogin, dootaskGetTokenExpire, dootaskGetCaptcha, syncDootaskToServer } from '@/sync/dootask/api';
import type { DooTaskProfile } from '@/sync/dootask/types';

function ensureHttpsPrefix(url: string): string {
    const trimmed = url.trim();
    if (!trimmed) return trimmed;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return 'https://' + trimmed;
}

export default React.memo(function DooTaskConnectPage() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();

    // Form state
    const [loginCache] = React.useState(() => loadDooTaskLoginCache());
    const [serverUrl, setServerUrl] = React.useState(loginCache.serverUrl);
    const [email, setEmail] = React.useState(loginCache.email);
    const [password, setPassword] = React.useState('');
    const [code, setCode] = React.useState('');
    const [codeNeed, setCodeNeed] = React.useState(false);
    const [codeKey, setCodeKey] = React.useState<string | null>(null);
    const [codeImg, setCodeImg] = React.useState<string | null>(null);
    const [codeLoading, setCodeLoading] = React.useState(false);

    // UI state
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    // Cache refs for unmount save (avoids stale closures)
    const serverUrlRef = React.useRef(serverUrl);
    const emailRef = React.useRef(email);
    React.useEffect(() => { serverUrlRef.current = serverUrl; }, [serverUrl]);
    React.useEffect(() => { emailRef.current = email; }, [email]);

    React.useEffect(() => {
        return () => {
            saveDooTaskLoginCache({
                serverUrl: serverUrlRef.current,
                email: emailRef.current,
            });
        };
    }, []);

    const fetchCaptcha = React.useCallback(async () => {
        const trimmedUrl = serverUrl.trim().replace(/\/+$/, '');
        if (!trimmedUrl) return;
        setCodeLoading(true);
        try {
            const captcha = await dootaskGetCaptcha(trimmedUrl);
            setCodeKey(captcha.key);
            setCodeImg(captcha.img);
            setCode('');
        } catch {
            setCodeImg(null);
        } finally {
            setCodeLoading(false);
        }
    }, [serverUrl]);

    const canSubmit = React.useMemo(() => {
        return serverUrl.trim().length > 0 && email.trim().length > 0 && password.length > 0;
    }, [serverUrl, email, password]);

    const handleLogin = React.useCallback(async () => {
        if (!canSubmit || loading) return;

        setError(null);
        setLoading(true);

        try {
            // Auto-prefix https:// if missing
            const prefixed = ensureHttpsPrefix(serverUrl);
            if (prefixed !== serverUrl) setServerUrl(prefixed);

            // Validate URL format before sending
            const trimmedUrl = prefixed.trim().replace(/\/+$/, '');
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

                    // Sync to server (fire-and-forget)
                    syncDootaskToServer({
                        serverUrl: profile.serverUrl,
                        token: profile.token,
                        userId: profile.userId,
                        username: profile.username,
                        avatar: profile.avatar,
                    }).catch(() => {});

                    router.back();
                    break;
                }

                case 'captcha_required': {
                    setCodeNeed(true);
                    setError(result.message || t('dootask.captchaRequired'));
                    fetchCaptcha();
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
    }, [canSubmit, loading, serverUrl, email, password, code, codeKey, router, fetchCaptcha]);

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
                <ItemGroup>
                    {/* Server URL */}
                    <View style={styles.fieldRow}>
                        <Text style={styles.fieldLabel}>{t('dootask.serverUrl')}</Text>
                        <TextInput
                            style={[styles.fieldInput, Platform.OS === 'web' && { outlineStyle: 'none', outline: 'none', outlineWidth: 0, outlineColor: 'transparent' } as any]}
                            value={serverUrl}
                            onChangeText={setServerUrl}
                            onBlur={() => setServerUrl(ensureHttpsPrefix(serverUrl))}
                            placeholder="https://your-dootask-server.com"
                            placeholderTextColor={theme.colors.textSecondary}
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="url"
                            textContentType="URL"
                            returnKeyType="next"
                        />
                    </View>
                    {/* Email */}
                    <View style={styles.fieldRow}>
                        <Text style={styles.fieldLabel}>{t('dootask.email')}</Text>
                        <TextInput
                            style={[styles.fieldInput, Platform.OS === 'web' && { outlineStyle: 'none', outline: 'none', outlineWidth: 0, outlineColor: 'transparent' } as any]}
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
                    {/* Password */}
                    <View style={styles.fieldRow}>
                        <Text style={styles.fieldLabel}>{t('dootask.password')}</Text>
                        <TextInput
                            style={[styles.fieldInput, Platform.OS === 'web' && { outlineStyle: 'none', outline: 'none', outlineWidth: 0, outlineColor: 'transparent' } as any]}
                            value={password}
                            onChangeText={setPassword}
                            placeholder={t('dootask.password')}
                            placeholderTextColor={theme.colors.textSecondary}
                            autoCapitalize="none"
                            autoCorrect={false}
                            secureTextEntry
                            textContentType="password"
                            returnKeyType={codeNeed ? 'next' : 'go'}
                            onSubmitEditing={codeNeed ? undefined : handleLogin}
                        />
                    </View>
                    {/* Captcha Code (conditional) */}
                    {codeNeed && (
                        <View style={styles.fieldRow}>
                            <Text style={styles.fieldLabel}>{t('dootask.captchaRequired')}</Text>
                            <View style={styles.captchaRow}>
                                <TextInput
                                    style={[styles.fieldInput, styles.captchaInput, Platform.OS === 'web' && { outlineStyle: 'none', outline: 'none', outlineWidth: 0, outlineColor: 'transparent' } as any]}
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
                                <Pressable onPress={fetchCaptcha} style={styles.captchaImageWrapper}>
                                    {codeLoading ? (
                                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                    ) : codeImg ? (
                                        <Image source={{ uri: codeImg }} style={styles.captchaImage} resizeMode="contain" />
                                    ) : (
                                        <Text style={styles.captchaError}>{t('dootask.captchaLoadFailed')}</Text>
                                    )}
                                </Pressable>
                            </View>
                        </View>
                    )}
                </ItemGroup>

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
    fieldRow: {
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    fieldLabel: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginBottom: 2,
        ...Typography.default('regular'),
    },
    fieldInput: {
        fontSize: 17,
        lineHeight: 22,
        color: theme.colors.text,
        paddingVertical: Platform.select({ ios: 4, default: 2 }),
        padding: 0,
        ...Typography.default(),
    },
    captchaRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    captchaInput: {
        flex: 1,
    },
    captchaImageWrapper: {
        height: 36,
        width: 100,
        marginLeft: 8,
        borderRadius: 6,
        backgroundColor: theme.colors.groupped.background,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
    },
    captchaImage: {
        width: 100,
        height: 36,
    },
    captchaError: {
        fontSize: 11,
        color: theme.colors.textDestructive,
        ...Typography.default('regular'),
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
