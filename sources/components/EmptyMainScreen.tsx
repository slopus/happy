import React from 'react';
import { View, Text, Platform, TextInput } from 'react-native';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/RoundButton';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { Modal } from '@/modal';
import { Alert } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

function ManualAuthModal({ onClose, onSubmit }: { 
    onClose: () => void; 
    onSubmit: (url: string) => void }
) {
    const { theme } = useUnistyles();
    const [url, setUrl] = React.useState('');
    return (
        <View style={{ padding: 20, backgroundColor: theme.colors.cardBackground, borderRadius: 12, minWidth: 300 }}>
            <Text style={{ fontSize: 18, fontWeight: '600', marginBottom: 8 }}>
                Enter URL manually
            </Text>
            <Text style={{ fontSize: 14, color: theme.colors.subtitleText, marginBottom: 16 }}>
                Paste the authentication URL from your terminal
            </Text>
            <TextInput
                style={{
                    borderWidth: 1,
                    borderColor: theme.colors.divider,
                    borderRadius: 8,
                    padding: 12,
                    fontSize: 14,
                    marginBottom: 20,
                    color: theme.colors.inputText,
                    backgroundColor: theme.colors.inputBackground
                }}
                value={url}
                onChangeText={setUrl}
                placeholder="happy://terminal?..."
                placeholderTextColor={theme.colors.inputPlaceholder}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
            />
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                <Text onPress={onClose} style={{ color: '#007AFF', fontSize: 16, paddingVertical: 8, paddingHorizontal: 16, marginRight: 8 }}>Cancel</Text>
                <Text onPress={() => { if (url.trim()) { onSubmit(url.trim()); onClose(); } }} style={{ color: '#007AFF', fontSize: 16, fontWeight: '600', paddingVertical: 8, paddingHorizontal: 16 }}>Authenticate</Text>
            </View>
        </View>
    );
}

export function EmptyMainScreen() {
    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal();

    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', marginBottom: 32 }}>
            {/* Terminal-style code block */}
            <Text style={{ marginBottom: 16, textAlign: 'center', fontSize: 24, ...Typography.default('semiBold') }}>Ready to code?</Text>
            <View style={{
                backgroundColor: '#444',
                borderRadius: 8,
                padding: 20,
                marginHorizontal: 24,
                marginBottom: 20,
                borderWidth: 1,
                borderColor: '#333'
            }}>

                <Text style={{ ...Typography.mono(), fontSize: 16, color: '#00ff00', marginBottom: 8 }}>
                    $ npm i -g happy-coder
                </Text>
                <Text style={{ ...Typography.mono(), fontSize: 16, color: '#00ff00' }}>
                    $ happy
                </Text>
            </View>


            {Platform.OS !== 'web' && (
                <>
                    <View style={{ marginTop: 12, marginHorizontal: 24, marginBottom: 48, width: 250 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                            <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.1)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                                <Text style={{ ...Typography.default('semiBold'), fontSize: 14, color: 'rgba(0,0,0,0.7)' }}>1</Text>
                            </View>
                            <Text style={{ ...Typography.default(), fontSize: 18, color: 'rgba(0,0,0,0.6)' }}>
                                Install the Happy CLI
                            </Text>
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                            <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.1)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                                <Text style={{ ...Typography.default('semiBold'), fontSize: 14, color: 'rgba(0,0,0,0.7)' }}>2</Text>
                            </View>
                            <Text style={{ ...Typography.default(), fontSize: 18, color: 'rgba(0,0,0,0.6)' }}>
                                Run it
                            </Text>
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.1)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                                <Text style={{ ...Typography.default('semiBold'), fontSize: 14, color: 'rgba(0,0,0,0.7)' }}>3</Text>
                            </View>
                            <Text style={{ ...Typography.default(), fontSize: 18, color: 'rgba(0,0,0,0.6)' }}>
                                Scan the QR code
                            </Text>
                        </View>
                    </View>
                    <View style={{ alignItems: 'center', width: '100%' }}>
                        <View style={{ width: 240, marginBottom: 12 }}>
                            <RoundButton
                                title="Open Camera"
                                size="large"
                                loading={isLoading}
                                onPress={connectTerminal}
                            />
                        </View>
                        <View style={{ width: 240 }}>
                            <RoundButton
                                title="Enter URL manually"
                                size="normal"
                                display="inverted"
                                onPress={() => {
                                    if (Platform.OS === 'ios') {
                                        Alert.prompt(
                                            'Authenticate Terminal',
                                            'Paste the authentication URL from your terminal',
                                            [
                                                { text: 'Cancel', style: 'cancel' },
                                                {
                                                    text: 'Authenticate',
                                                    onPress: (url?: string) => {
                                                        if (url?.trim()) {
                                                            connectWithUrl(url.trim());
                                                        }
                                                    }
                                                }
                                            ],
                                            'plain-text',
                                            '',
                                            'happy://terminal?...'
                                        );
                                    } else {
                                        Modal.show({
                                            component: ManualAuthModal,
                                            props: {
                                                onSubmit: (url: string) => connectWithUrl(url)
                                            }
                                        });
                                    }
                                }}
                            />
                        </View>
                    </View>
                </>
            )}
        </View>
    );
}