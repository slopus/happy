import { RoundButton } from "@/components/RoundButton";
import { useAuth } from "@/auth/AuthContext";
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Alert, Text, View } from "react-native";
import { CameraView } from 'expo-camera';
import * as React from 'react';
import { decodeBase64, encodeBase64 } from "@/auth/base64";
import { authGetToken } from "@/auth/authGetToken";
import { useSessions } from "@/sync/useSessions";
import { useUpdates } from "@/hooks/useUpdates";
import { UpdateBanner } from "@/components/UpdateBanner";
import { SessionsList } from "@/components/SessionsList";
import { useRouter } from "expo-router";


console.log('NativeWind version:', require('nativewind/package.json').version);

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
    const [sessions, isLoaded] = useSessions();
    const { updateAvailable, reloadApp } = useUpdates();

    if (!isLoaded) {
        return (
            <View className="flex-1 items-center justify-center mb-8">
                <ActivityIndicator size="small" color="#000000" />
            </View>
        )
    }

    return (
        <View className="flex-1">
            {updateAvailable && <UpdateBanner onReload={reloadApp} />}

            {sessions.length === 0 ? (
                <View className="flex-1 items-center justify-center mb-8">
                    <Text>No sessions</Text>
                </View>
            ) : (
                <>
                    <SessionsList sessions={sessions} />
                    <View className="bg-red-500 p-4 mx-4 mb-4 rounded-lg hack">
                        <Text className="text-white text-center font-bold">
                            🎉 NativeWind is working! This is styled with Tailwind classes.
                        </Text>
                    </View>
                </>
            )}
        </View>
    )
}

function NotAuthenticated() {
    const auth = useAuth();
    const router = useRouter();
    const [isLoading, setIsLoading] = React.useState(false);

    React.useEffect(() => {
        const subscription = CameraView.onModernBarcodeScanned(async (event) => {
            if (event.data.startsWith('handy://')) {
                setIsLoading(true);
                await CameraView.dismissScanner();
                try {
                    const tail = event.data.slice('handy://'.length);
                    await processAuthCode(tail);
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

    const processAuthCode = async (code: string) => {
        console.log(code);
        const secret = decodeBase64(code, 'base64url');
        console.log(secret);
        if (secret.length !== 32) {
            throw new Error('Invalid secret');
        }

        // Exchange secret for token
        const token = await authGetToken(secret);

        if (token && secret) {
            await auth.login(token, encodeBase64(secret, 'base64url'));
        }
    };

    const openCamera = async () => {
        await CameraView.launchScanner({
            barcodeTypes: ['qr']
        });
    }

    return (
        <View className="flex-1 items-center justify-center">
            <Ionicons name="qr-code-outline" size={120} color="#000" className="mb-8" />
            <Text className="text-center text-2xl mb-8 mx-8">
                Scan the QR code from your terminal to login
            </Text>
            <View className="max-w-[200px] w-full mb-4">
                <RoundButton
                    loading={isLoading}
                    title="Open Camera"
                    action={openCamera} />
            </View>
            <RoundButton
                title="Enter Code Manually"
                onPress={() => router.push('/manual-entry')}
                display="inverted" />
        </View>
    )
}

