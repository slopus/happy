import * as React from 'react';
import { View, TextInput, Text } from 'react-native';
import { RoundButton } from './RoundButton';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';

export const ConnectButton = React.memo(() => {
    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal();
    const [manualUrl, setManualUrl] = React.useState('');
    const isDevMode = process.env.EXPO_PUBLIC_DEBUG === '1';

    const handleConnect = async () => {
        if (isDevMode && manualUrl.trim()) {
            // Process manual URL in dev mode
            connectWithUrl(manualUrl.trim());
        } else {
            // Use camera scanner
            connectTerminal();
        }
    };

    return (
        <View style={{ width: 210 }}>
            {isDevMode && (
                <View style={{
                    marginBottom: 16,
                    padding: 16,
                    borderRadius: 8,
                    width: 200,
                }}>
                    <Text style={{
                        fontSize: 14,
                        fontWeight: '600',
                        marginBottom: 8,
                        color: '#333',
                    }}>Dev Mode: Manual URL Entry</Text>
                    <TextInput
                        style={{
                            backgroundColor: 'white',
                            borderWidth: 1,
                            borderColor: '#ddd',
                            borderRadius: 8,
                            padding: 12,
                        }}
                        value={manualUrl}
                        onChangeText={setManualUrl}
                        placeholder="Paste happy://terminal?... URL here"
                        placeholderTextColor="#666"
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                </View>
            )}
            <RoundButton
                title="Connect"
                size="large"
                onPress={handleConnect}
                loading={isLoading}
            />
        </View>
    )
});