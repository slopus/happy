import * as React from 'react';
import { View, TextInput, Text, TouchableOpacity } from 'react-native';
import { RoundButton } from './RoundButton';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { trackConnectAttempt } from '@/track';
import { Ionicons } from '@expo/vector-icons';

export const ConnectButton = React.memo(() => {
    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal();
    const [manualUrl, setManualUrl] = React.useState('');
    const [showManualEntry, setShowManualEntry] = React.useState(false);

    const handleConnect = async () => {
        trackConnectAttempt();
        connectTerminal();
    };

    const handleManualConnect = async () => {
        if (manualUrl.trim()) {
            trackConnectAttempt();
            connectWithUrl(manualUrl.trim());
            setManualUrl('');
        }
    };

    return (
        <View style={{ width: 210 }}>
            <RoundButton
                title="Authenticate Terminal"
                size="large"
                onPress={handleConnect}
                loading={isLoading}
            />
            
            <TouchableOpacity
                onPress={() => setShowManualEntry(!showManualEntry)}
                style={{
                    marginTop: 12,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                <Ionicons 
                    name="link-outline" 
                    size={16} 
                    color="#666" 
                    style={{ marginRight: 6 }}
                />
                <Text style={{
                    fontSize: 14,
                    color: '#666',
                    textDecorationLine: 'underline',
                }}>
                    Authenticate Terminal with URL paste
                </Text>
            </TouchableOpacity>

            {showManualEntry && (
                <View style={{
                    marginTop: 12,
                    padding: 12,
                    borderRadius: 8,
                    backgroundColor: '#f5f5f5',
                    width: 210,
                }}>
                    <Text style={{
                        fontSize: 12,
                        color: '#666',
                        marginBottom: 8,
                    }}>
                        Paste the auth URL from your terminal
                    </Text>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                    }}>
                        <TextInput
                            style={{
                                flex: 1,
                                backgroundColor: 'white',
                                borderWidth: 1,
                                borderColor: '#ddd',
                                borderRadius: 6,
                                padding: 8,
                                fontSize: 12,
                            }}
                            value={manualUrl}
                            onChangeText={setManualUrl}
                            placeholder="happy://terminal?..."
                            placeholderTextColor="#999"
                            autoCapitalize="none"
                            autoCorrect={false}
                            onSubmitEditing={handleManualConnect}
                        />
                        <TouchableOpacity
                            onPress={handleManualConnect}
                            disabled={!manualUrl.trim()}
                            style={{
                                marginLeft: 8,
                                padding: 8,
                                opacity: manualUrl.trim() ? 1 : 0.5,
                            }}
                        >
                            <Ionicons 
                                name="checkmark-circle" 
                                size={24} 
                                color="#007AFF" 
                            />
                        </TouchableOpacity>
                    </View>
                </View>
            )}
        </View>
    )
});