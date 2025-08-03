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

export default function ServerConfigScreen() {
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
                style={{ flex: 1 }}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <ItemList style={{ flex: 1 }}>
                    <ItemGroup footer="This is an advanced feature. Only change the server if you know what you're doing. You will need to log out and log in again after changing servers.">
                        <View style={{ 
                            backgroundColor: 'white',
                            paddingHorizontal: 16,
                            paddingVertical: 12,
                            width: '100%',
                            maxWidth: layout.maxWidth,
                            alignSelf: 'center'
                        }}>
                            <Text style={{
                                ...Typography.default('semiBold'),
                                fontSize: 12,
                                color: '#8E8E93',
                                textTransform: 'uppercase',
                                letterSpacing: 0.5,
                                marginBottom: 8
                            }}>
                                CUSTOM SERVER URL
                            </Text>
                            <TextInput
                                style={{
                                    backgroundColor: '#f3f4f6',
                                    padding: 12,
                                    borderRadius: 8,
                                    marginBottom: 8,
                                    ...Typography.mono(),
                                    fontSize: 14,
                                    opacity: isValidating ? 0.6 : 1,
                                }}
                                value={inputUrl}
                                onChangeText={(text) => {
                                    setInputUrl(text);
                                    setError(null);
                                }}
                                placeholder="https://example.com"
                                placeholderTextColor="#C7C7CC"
                                autoCapitalize="none"
                                autoCorrect={false}
                                keyboardType="url"
                                editable={!isValidating}
                            />
                            {error && (
                                <Text style={{ 
                                    ...Typography.default(), 
                                    fontSize: 12, 
                                    color: '#FF3B30', 
                                    marginBottom: 12 
                                }}>
                                    {error}
                                </Text>
                            )}
                            {isValidating && (
                                <Text style={{ 
                                    ...Typography.default(), 
                                    fontSize: 12, 
                                    color: '#007AFF', 
                                    marginBottom: 12 
                                }}>
                                    Validating server...
                                </Text>
                            )}
                            <View style={{ flexDirection: 'row', gap: 12, marginBottom: 12 }}>
                                <View style={{ flex: 1 }}>
                                    <RoundButton
                                        title="Reset to Default"
                                        size="normal"
                                        display="inverted"
                                        onPress={handleReset}
                                    />
                                </View>
                                <View style={{ flex: 1 }}>
                                    <RoundButton
                                        title={isValidating ? "Validating..." : "Save"}
                                        size="normal"
                                        action={handleSave}
                                        disabled={isValidating}
                                    />
                                </View>
                            </View>
                            {serverInfo.isCustom && (
                                <Text style={{ 
                                    ...Typography.default(), 
                                    fontSize: 12, 
                                    color: '#8E8E93', 
                                    textAlign: 'center' 
                                }}>
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