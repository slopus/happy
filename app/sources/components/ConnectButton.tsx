import * as React from 'react';
import { Alert, View } from 'react-native';
import { RoundButton } from './RoundButton';
import { CameraView } from 'expo-camera';
import { useAuth } from '@/auth/AuthContext';
import { decodeBase64 } from '@/auth/base64';
import { encryptWithEphemeralKey } from '@/sync/apiEncryption';
import { authApprove } from '@/auth/authApprove';

export const ConnectButton = React.memo(() => {

    const auth = useAuth();
    const [isLoading, setIsLoading] = React.useState(false);

    const connectTerminal = () => {
        CameraView.launchScanner({
            barcodeTypes: ['qr']
        });
    }

    React.useEffect(() => {
        if (CameraView.isModernBarcodeScannerAvailable) {
            const subscription = CameraView.onModernBarcodeScanned(async (event) => {
                if (event.data.startsWith('happy://terminal?')) {
                    setIsLoading(true);
                    await CameraView.dismissScanner();
                    try {
                        const tail = event.data.slice('happy://terminal?'.length);
                        const response = encryptWithEphemeralKey(decodeBase64(auth.credentials!.secret), decodeBase64(tail));
                        await authApprove(auth.credentials!.token, response.ephemeralPublicKey, response.encrypted);
                    } catch (e) {
                        console.error(e);
                        Alert.alert('Error', 'Failed to login', [{ text: 'OK' }]);
                    } finally {
                        setIsLoading(false);
                    }
                }
            });
            return () => {
                subscription.remove();
            };
        }
    }, []);

    return (
        <View className="max-w-[220px] w-full mb-4">
            <RoundButton
                title="Connect terminal"
                onPress={connectTerminal}
                loading={isLoading}
            />
        </View>
    )
});