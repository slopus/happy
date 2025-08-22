import React, { useState } from 'react';
import { View, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { RoundButton } from '@/components/RoundButton';
import { Modal } from '@/modal';
import { layout } from '@/components/layout';
import { getServerUrl, setServerUrl, validateServerUrl, getServerInfo } from '@/sync/serverConfig';
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
}));

export default function ServerConfigScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const serverInfo = getServerInfo();
    const [inputUrl, setInputUrl] = useState(serverInfo.isCustom ? getServerUrl() : '');
    const [error, setError] = useState<string | null>(null);
    const [isValidating, setIsValidating] = useState(false);

    const validateServer = async (url: string): Promise<boolean> => {
        try {
            setIsValidating(true);
            setError(null);
            
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'text/plain'
                }
            });
            
            if (!response.ok) {
                setError('Server returned an error');
                return false;
            }
            
            const text = await response.text();
            if (!text.includes('Welcome to Happy Server!')) {
                setError('Not a valid Happy Server');
                return false;
            }
            
            return true;
        } catch (err) {
            setError('Failed to connect to server');
            return false;
        } finally {
            setIsValidating(false);
        }
    };

    const handleSave = async () => {
        if (!inputUrl.trim()) {
            Modal.alert('Error', 'Please enter a server URL');
            return;
        }

        const validation = validateServerUrl(inputUrl);
        if (!validation.valid) {
            setError(validation.error || 'Invalid URL');
            return;
        }

        // Validate the server
        const isValid = await validateServer(inputUrl);
        if (!isValid) {
            return;
        }

        const confirmed = await Modal.confirm(
            'Change Server',
            'Continue with this server?',
            { confirmText: 'Continue', destructive: true }
        );

        if (confirmed) {
            setServerUrl(inputUrl);
        }
    };

    const handleReset = async () => {
        const confirmed = await Modal.confirm(
            'Reset to Default',
            'Reset server to default?',
            { confirmText: 'Reset', destructive: true }
        );

        if (confirmed) {
            setServerUrl(null);
            setInputUrl('');
        }
    };

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: 'Server Configuration',
                    headerBackTitle: 'Back',
                }}
            />

            <KeyboardAvoidingView 
                style={styles.keyboardAvoidingView}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <ItemList style={styles.itemListContainer}>
                    <ItemGroup footer="This is an advanced feature. Only change the server if you know what you're doing. You will need to log out and log in again after changing servers.">
                        <View style={styles.contentContainer}>
                            <Text style={styles.labelText}>
                                CUSTOM SERVER URL
                            </Text>
                            <TextInput
                                style={[
                                    styles.textInput,
                                    isValidating && styles.textInputValidating
                                ]}
                                value={inputUrl}
                                onChangeText={(text) => {
                                    setInputUrl(text);
                                    setError(null);
                                }}
                                placeholder="https://example.com"
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="none"
                                autoCorrect={false}
                                keyboardType="url"
                                editable={!isValidating}
                            />
                            {error && (
                                <Text style={styles.errorText}>
                                    {error}
                                </Text>
                            )}
                            {isValidating && (
                                <Text style={styles.validatingText}>
                                    Validating server...
                                </Text>
                            )}
                            <View style={styles.buttonRow}>
                                <View style={styles.buttonWrapper}>
                                    <RoundButton
                                        title="Reset to Default"
                                        size="normal"
                                        display="inverted"
                                        onPress={handleReset}
                                    />
                                </View>
                                <View style={styles.buttonWrapper}>
                                    <RoundButton
                                        title={isValidating ? "Validating..." : "Save"}
                                        size="normal"
                                        action={handleSave}
                                        disabled={isValidating}
                                    />
                                </View>
                            </View>
                            {serverInfo.isCustom && (
                                <Text style={styles.statusText}>
                                    Currently using custom server
                                </Text>
                            )}
                        </View>
                    </ItemGroup>

                    </ItemList>
            </KeyboardAvoidingView>
        </>
    );
}