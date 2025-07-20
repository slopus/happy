import { RoundButton } from "@/components/RoundButton";
import { useAuth } from "@/auth/AuthContext";
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Alert, Image, Platform, Pressable, Text, View } from "react-native";
import { CameraView } from 'expo-camera';
import * as React from 'react';
import { decodeBase64, encodeBase64 } from "@/auth/base64";
import { authGetToken } from "@/auth/authGetToken";
import { useUpdates } from "@/hooks/useUpdates";
import { UpdateBanner } from "@/components/UpdateBanner";
import { SessionsList } from "@/components/SessionsList";
import { Stack, useRouter } from "expo-router";
import { useSessions } from "@/sync/storage";
import LottieView from "lottie-react-native";
import { getRandomBytesAsync } from "expo-crypto";
import { ConnectButton } from "@/components/ConnectButton";
import { Typography } from "@/constants/Typography";

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
    const sessionsData = useSessions();
    const { updateAvailable, reloadApp } = useUpdates();

    if (sessionsData === null) {
        return (
            <View className="flex-1 items-center justify-center mb-8">
                <ActivityIndicator size="small" color="#000000" />
            </View>
        )
    }

    return (
        <>
            <Stack.Screen
                options={{
                    headerRight: () => <HeaderRight />
                }}
            />
            <View className="flex-1">
                {updateAvailable && <UpdateBanner onReload={reloadApp} />}

                {sessionsData.length === 0 ? (
                    <View className="flex-1 items-center justify-center mb-8">
                        <LottieView source={require('@/assets/animations/stone.json')} autoPlay={true} loop={false} style={{ width: 180, height: 180 }} />
                        <Text style={{ fontSize: 24, marginTop: 16 }}>No sessions</Text>
                        {Platform.OS !== 'web' && (
                            <>
                                <Text style={{ fontSize: 18, color: 'rgba(0,0,0,0.6)', marginTop: 16, textAlign: 'center', marginHorizontal: 24, marginBottom: 64 }}>Connect your terminal to your account</Text>
                                <ConnectButton />
                            </>
                        )}
                    </View>
                ) : (
                    <SessionsList data={sessionsData} />
                )}
            </View>
        </>
    )
}

function NotAuthenticated() {
    const auth = useAuth();

    const createAccount = async () => {
        const secret = await getRandomBytesAsync(32);
        const token = await authGetToken(secret);
        if (token && secret) {
            await auth.login(token, encodeBase64(secret, 'base64url'));
        }
    }

    // const router = useRouter();
    // const [isLoading, setIsLoading] = React.useState(false);

    // React.useEffect(() => {
    //     if (CameraView.isModernBarcodeScannerAvailable) {
    //         const subscription = CameraView.onModernBarcodeScanned(async (event) => {
    //             if (event.data.startsWith('handy://')) {
    //                 setIsLoading(true);
    //                 await CameraView.dismissScanner();
    //                 try {
    //                     const tail = event.data.slice('handy://'.length);
    //                     await processAuthCode(tail);
    //                 } catch (e) {
    //                     console.error(e);
    //                     Alert.alert('Error', 'Failed to login', [{ text: 'OK' }]);
    //                 } finally {
    //                     setIsLoading(false);
    //                 }
    //             }
    //         });
    //         return () => {
    //             subscription.remove();
    //         };
    //     }
    // }, [auth]);

    // const processAuthCode = async (code: string) => {
    //     console.log(code);
    //     const secret = decodeBase64(code, 'base64url');
    //     console.log(secret);
    //     if (secret.length !== 32) {
    //         throw new Error('Invalid secret');
    //     }

    //     // Exchange secret for token
    //     const token = await authGetToken(secret);

    //     if (token && secret) {
    //         await auth.login(token, encodeBase64(secret, 'base64url'));
    //     }
    // };

    // const openCamera = async () => {
    //     await CameraView.launchScanner({
    //         barcodeTypes: ['qr']
    //     });
    // }

    return (
        <>
            <Stack.Screen
                options={{
                    headerRight: () => null
                }}
            />
            <View className="flex-1 items-center justify-center">
                <LottieView source={require('@/assets/animations/owl.json')} autoPlay={true} loop={false} style={{ width: 180, height: 180 }} />
                <Text style={{ fontSize: 28, ...Typography.default('semiBold') }}>
                    Hello there!
                </Text>
                <Text style={{ ...Typography.default(), fontSize: 18, color: 'rgba(0,0,0,0.6)', marginTop: 16, textAlign: 'center', marginHorizontal: 24, marginBottom: 64 }}>
                    Happy Coder is an end-to-end encrypted Claude Code mobile client.
                </Text>
                <View className="max-w-[200px] w-full mb-4">
                    <RoundButton
                        title="Create account"
                        action={createAccount}
                    />
                </View>
            </View>
        </>
    )
}

function HeaderRight() {
    const router = useRouter();

    return (
        <Pressable
            onPress={() => router.push('/about')}
            hitSlop={10}
        >
            <LottieView source={require('@/assets/animations/game.json')} autoPlay={true} loop={false} style={{ width: 32, height: 32 }} />
        </Pressable>
    );
}