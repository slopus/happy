import { RoundButton } from "@/components/RoundButton";
import { useAuth } from "@/auth/AuthContext";
import { Ionicons } from '@expo/vector-icons';
import { Alert, Text, View } from "react-native";
import { CameraView } from 'expo-camera';
import * as React from 'react';
import { decodeBase64, encodeBase64 } from "@/auth/base64";
import { authGetToken } from "@/auth/authGetToken";

export default function Home() {
    const auth = useAuth();
    if (!auth.isAuthenticated) {
        return <NotAuthenticated />;
    }
    return (
        <Authenticated />
    )
}

function Authenticated() {
    return (
        <View>
            <Text>Authenticated</Text>
        </View>
    )
}

function NotAuthenticated() {
    const auth = useAuth();
    const [isLoading, setIsLoading] = React.useState(false);

    React.useEffect(() => {
        const subscription = CameraView.onModernBarcodeScanned(async (event) => {
            if (event.data.startsWith('handy://')) {
                setIsLoading(true);
                await CameraView.dismissScanner();
                try {
                    const tail = event.data.slice('handy://'.length);

                    // Read secret
                    console.log(tail);
                    const secret = decodeBase64(tail, 'base64url');
                    console.log(secret);
                    if (secret.length !== 32) {
                        throw new Error('Invalid secret');
                    }

                    // Exchange secret for token
                    const token = await authGetToken(secret);
                    console.log(token);

                    if (token && secret) {
                        await auth.login(token, encodeBase64(secret, 'base64url'));
                    }
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
    }, [auth]);

    const openCamera = async () => {
        await CameraView.launchScanner({
            barcodeTypes: ['qr']
        });
    }

    return (
        <View style={{ flexGrow: 1, flexBasis: 0, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="qr-code-outline" size={120} color="#000" style={{ marginBottom: 32 }} />
            <Text style={{ textAlign: 'center', fontSize: 24, marginBottom: 32, marginHorizontal: 32 }}>
                Scan the QR code from your terminal to login
            </Text>
            <View style={{ maxWidth: 200, width: '100%' }}>
                <RoundButton
                    loading={isLoading ? true : undefined}
                    title="Open Camera"
                    action={openCamera} />
            </View>
        </View>
    )
}