import * as React from 'react';
import { Alert, View, TextInput, Text, StyleSheet } from 'react-native';
import { RoundButton } from './RoundButton';
import { CameraView } from 'expo-camera';
import { useAuth } from '@/auth/AuthContext';
import { decodeBase64 } from '@/auth/base64';
import { encryptBox } from '@/encryption/libsodium';
import { authApprove } from '@/auth/authApprove';
import { useCheckScannerPermissions } from '@/hooks/useCheckCameraPermissions';

export const ConnectButton = React.memo(() => {
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
            Alert.alert('Success', 'Terminal connected successfully', [{ text: 'OK' }]);
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
        <View>
            {isDevMode && (
                <View style={{
                    marginBottom: 16,
                    padding: 16,
                    backgroundColor: '#f5f5f5',
                    borderRadius: 8,
                    width: 300,
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
                size="normal"
                onPress={connectTerminal}
                loading={isLoading}
            />
        </View>
    )
});