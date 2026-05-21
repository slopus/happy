import React, { useEffect, useMemo, useState } from 'react';
import { View, TextInput, KeyboardAvoidingView, Platform, Switch } from 'react-native';
import { Stack } from 'expo-router';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { RoundButton } from '@/components/RoundButton';
import { Modal } from '@/modal';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { getServerUrl, setServerUrl, validateServerUrl, getServerInfo } from '@/sync/serverConfig';
import {
    ServerCredentialsStore,
    inlineCredentials,
    stripCredentials,
    extractCredentials,
} from '@/sync/serverCredentialsStore';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

const stylesheet = StyleSheet.create((theme) => ({
    keyboardAvoidingView: {
        flex: 1,
    },
    itemListContainer: {
        flex: 1,
    },
    contentContainer: {
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 16,
        paddingVertical: 12,
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
    },
    labelText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 8,
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        padding: 12,
        borderRadius: 8,
        marginBottom: 8,
        ...Typography.mono(),
        fontSize: 14,
        color: theme.colors.input.text,
    },
    textInputValidating: {
        opacity: 0.6,
    },
    errorText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textDestructive,
        marginBottom: 12,
    },
    validatingText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.status.connecting,
        marginBottom: 12,
    },
    buttonRow: {
        flexDirection: 'row',
        gap: 12,
        marginBottom: 12,
    },
    buttonWrapper: {
        flex: 1,
    },
    statusText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    toggleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        marginTop: 4,
        marginBottom: 8,
    },
    toggleLabel: {
        flex: 1,
        ...Typography.default(),
        fontSize: 14,
        color: theme.colors.text,
    },
    toggleHint: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginBottom: 12,
    },
}));

export default function ServerConfigScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const serverInfo = getServerInfo();

    // Strip any inlined credentials from the displayed URL — they live in
    // the user/pass fields below.
    const initialDisplayUrl = useMemo(
        () => (serverInfo.isCustom ? stripCredentials(getServerUrl()) : ''),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        []
    );

    const [inputUrl, setInputUrl] = useState(initialDisplayUrl);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [rememberCreds, setRememberCreds] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isValidating, setIsValidating] = useState(false);

    // On mount: re-hydrate credentials from secure store; fall back to ones
    // inlined in the current serverUrl. Either way, switch the toggle on if
    // we found anything stored.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const fromStore = await ServerCredentialsStore.get();
            if (cancelled) return;
            if (fromStore) {
                setUsername(fromStore.username);
                setPassword(fromStore.password);
                setRememberCreds(true);
                return;
            }
            // Best-effort: parse credentials currently inlined in MMKV URL
            const fromUrl = extractCredentials(getServerUrl());
            if (fromUrl) {
                setUsername(fromUrl.username);
                setPassword(fromUrl.password);
                // Default off if we found them in the URL — user hasn't
                // explicitly opted into secure storage yet.
                setRememberCreds(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const validateServer = async (composedUrl: string): Promise<boolean> => {
        try {
            setIsValidating(true);
            setError(null);
            const response = await fetch(composedUrl, {
                method: 'GET',
                headers: { 'Accept': 'text/plain' },
            });
            if (!response.ok) {
                setError(t('server.serverReturnedError'));
                return false;
            }
            const text = await response.text();
            if (!text.includes('Welcome to Happy Server!')) {
                setError(t('server.notValidHappyServer'));
                return false;
            }
            return true;
        } catch {
            setError(t('server.failedToConnectToServer'));
            return false;
        } finally {
            setIsValidating(false);
        }
    };

    const handleSave = async () => {
        if (!inputUrl.trim()) {
            Modal.alert(t('common.error'), t('server.enterServerUrl'));
            return;
        }
        const validation = validateServerUrl(inputUrl);
        if (!validation.valid) {
            setError(validation.error || t('errors.invalidFormat'));
            return;
        }

        const creds = (username.trim() && password.length > 0)
            ? { username: username.trim(), password }
            : null;
        const composed = inlineCredentials(inputUrl.trim(), creds);

        const isValid = await validateServer(composed);
        if (!isValid) return;

        const confirmed = await Modal.confirm(
            t('server.changeServer'),
            t('server.continueWithServer'),
            { confirmText: t('common.continue'), destructive: true }
        );
        if (!confirmed) return;

        setServerUrl(composed);

        if (creds && rememberCreds) {
            await ServerCredentialsStore.set(creds);
        } else {
            // User unchecked the toggle (or has no creds) — purge any
            // previously-saved credentials from the keychain.
            await ServerCredentialsStore.clear();
        }
    };

    const handleReset = async () => {
        const confirmed = await Modal.confirm(
            t('server.resetToDefault'),
            t('server.resetServerDefault'),
            { confirmText: t('common.reset'), destructive: true }
        );
        if (!confirmed) return;
        setServerUrl(null);
        await ServerCredentialsStore.clear();
        setInputUrl('');
        setUsername('');
        setPassword('');
        setRememberCreds(false);
    };

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: t('server.serverConfiguration'),
                    headerBackTitle: t('common.back'),
                }}
            />

            <KeyboardAvoidingView
                style={styles.keyboardAvoidingView}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <ItemList style={styles.itemListContainer}>
                    <ItemGroup footer={t('server.advancedFeatureFooter')}>
                        <View style={styles.contentContainer}>
                            <Text style={styles.labelText}>{t('server.customServerUrlLabel').toUpperCase()}</Text>
                            <TextInput
                                style={[
                                    styles.textInput,
                                    isValidating && styles.textInputValidating,
                                ]}
                                value={inputUrl}
                                onChangeText={(text) => { setInputUrl(text); setError(null); }}
                                placeholder={t('common.urlPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="none"
                                autoCorrect={false}
                                keyboardType="url"
                                editable={!isValidating}
                            />
                            {error && <Text style={styles.errorText}>{error}</Text>}
                            {isValidating && <Text style={styles.validatingText}>{t('server.validatingServer')}</Text>}
                        </View>
                    </ItemGroup>

                    <ItemGroup footer={t('server.basicAuthFooter')}>
                        <View style={styles.contentContainer}>
                            <Text style={styles.labelText}>{t('server.basicAuthLabel').toUpperCase()}</Text>
                            <TextInput
                                style={[styles.textInput, isValidating && styles.textInputValidating]}
                                value={username}
                                onChangeText={setUsername}
                                placeholder={t('server.usernameLabel')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="none"
                                autoCorrect={false}
                                editable={!isValidating}
                                textContentType="username"
                            />
                            <TextInput
                                style={[styles.textInput, isValidating && styles.textInputValidating]}
                                value={password}
                                onChangeText={setPassword}
                                placeholder={t('server.passwordLabel')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="none"
                                autoCorrect={false}
                                secureTextEntry
                                editable={!isValidating}
                                textContentType="password"
                            />
                            <View style={styles.toggleRow}>
                                <Text style={styles.toggleLabel}>{t('server.rememberCredentials')}</Text>
                                <Switch
                                    value={rememberCreds}
                                    onValueChange={setRememberCreds}
                                    disabled={isValidating}
                                />
                            </View>
                            <Text style={styles.toggleHint}>{t('server.rememberCredentialsHint')}</Text>

                            <View style={styles.buttonRow}>
                                <View style={styles.buttonWrapper}>
                                    <RoundButton
                                        title={t('server.resetToDefault')}
                                        size="normal"
                                        display="inverted"
                                        onPress={handleReset}
                                    />
                                </View>
                                <View style={styles.buttonWrapper}>
                                    <RoundButton
                                        title={isValidating ? t('server.validating') : t('common.save')}
                                        size="normal"
                                        action={handleSave}
                                        disabled={isValidating}
                                    />
                                </View>
                            </View>
                            {serverInfo.isCustom && (
                                <Text style={styles.statusText}>
                                    {t('server.currentlyUsingCustomServer')}
                                </Text>
                            )}
                        </View>
                    </ItemGroup>
                </ItemList>
            </KeyboardAvoidingView>
        </>
    );
}
