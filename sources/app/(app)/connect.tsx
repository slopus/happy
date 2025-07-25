import * as React from 'react';
import { View, Text, TextInput, Alert, Platform, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { RoundButton } from '@/components/RoundButton';
import { CameraView } from 'expo-camera';
import { useAuth } from '@/auth/AuthContext';
import { decodeBase64 } from '@/auth/base64';
import { encryptBox } from '@/encryption/libsodium';
import { authApprove } from '@/auth/authApprove';
import { useCheckScannerPermissions } from '@/hooks/useCheckCameraPermissions';
import { Ionicons } from '@expo/vector-icons';

export default function ConnectScreen() {
    const router = useRouter();
    const auth = useAuth();
    const [isLoading, setIsLoading] = React.useState(false);
    const [manualUrl, setManualUrl] = React.useState('');
    const isDevMode = process.env.EXPO_PUBLIC_DEBUG === '1';
    const checkScannerPermissions = useCheckScannerPermissions();

    const processAuthUrl = async (url: string) => {
        if (!url.startsWith('happy://terminal?')) {
            Alert.alert('Error', 'Invalid authentication URL', [{ text: 'OK' }]);
            return;
        }
        
        setIsLoading(true);
        try {
            const tail = url.slice('happy://terminal?'.length);
            const publicKey = decodeBase64(tail, 'base64url');
            const response = encryptBox(decodeBase64(auth.credentials!.secret, 'base64url'), publicKey);
            await authApprove(auth.credentials!.token, publicKey, response);
            Alert.alert('Success', 'Terminal connected successfully', [
                { text: 'OK', onPress: () => router.back() }
            ]);
            setManualUrl('');
        } catch (e) {
            console.error(e);
            Alert.alert('Error', 'Failed to connect terminal', [{ text: 'OK' }]);
        } finally {
            setIsLoading(false);
        }
    };

    const connectTerminal = async () => {
        if (isDevMode && manualUrl.trim()) {
            // Process manual URL in dev mode
            processAuthUrl(manualUrl.trim());
        } else if (await checkScannerPermissions()) {
            // Use camera scanner
            CameraView.launchScanner({
                barcodeTypes: ['qr']
            });
        } else {
            Alert.alert('Error', 'Camera permissions are required to connect terminal', [{ text: 'OK' }]);
        }
    }

    React.useEffect(() => {
        if (CameraView.isModernBarcodeScannerAvailable) {
            const subscription = CameraView.onModernBarcodeScanned(async (event) => {
                if (event.data.startsWith('happy://terminal?')) {
                    await CameraView.dismissScanner();
                    await processAuthUrl(event.data);
                }
            });
            return () => {
                subscription.remove();
            };
        }
    }, []);

    return (
        <View style={{ flex: 1, backgroundColor: '#F2F2F7' }}>
            <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingHorizontal: 8,
                paddingTop: Platform.OS === 'ios' ? 10 : 20,
                paddingBottom: 10,
                backgroundColor: 'white',
            }}>
                <Pressable
                    onPress={() => router.back()}
                    style={{ padding: 8 }}
                >
                    <Ionicons name="chevron-back" size={24} color="#007AFF" />
                </Pressable>
                <Text style={{ fontSize: 18, fontWeight: '600', flex: 1, textAlign: 'center', marginRight: 40 }}>
                    Connect Terminal
                </Text>
            </View>

            <ItemList style={{ paddingTop: 20 }}>
                <ItemGroup title="Connect Claude Code">
                    <Item 
                        title="Scan QR Code"
                        subtitle="Scan the QR code shown in Claude Code terminal"
                        icon={<Ionicons name="qr-code-outline" size={29} color="#007AFF" />}
                        onPress={() => connectTerminal()}
                    />
                </ItemGroup>

                {isDevMode && (
                    <ItemGroup title="Developer Mode">
                        <View style={{ 
                            backgroundColor: 'white',
                            padding: 16,
                        }}>
                            <Text style={{
                                fontSize: 14,
                                color: '#8E8E93',
                                marginBottom: 12,
                            }}>
                                Manual URL Entry
                            </Text>
                            <TextInput
                                style={{
                                    backgroundColor: '#F2F2F7',
                                    borderRadius: 8,
                                    padding: 12,
                                    fontSize: 16,
                                    marginBottom: 16,
                                }}
                                value={manualUrl}
                                onChangeText={setManualUrl}
                                placeholder="Paste happy://terminal?... URL"
                                placeholderTextColor="#999"
                                autoCapitalize="none"
                                autoCorrect={false}
                                multiline={true}
                                numberOfLines={3}
                            />
                            <RoundButton
                                title="Connect with URL"
                                size="normal"
                                onPress={() => manualUrl.trim() && processAuthUrl(manualUrl.trim())}
                                loading={isLoading}
                                disabled={!manualUrl.trim()}
                            />
                        </View>
                    </ItemGroup>
                )}

                <ItemGroup footer="Open Claude Code in your terminal and follow the instructions to display a QR code. Then scan it with this app to establish a secure connection.">
                    <View />
                </ItemGroup>
            </ItemList>
        </View>
    );
}