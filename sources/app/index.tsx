import { RoundButton } from "@/components/RoundButton";
import { useAuth } from "@/auth/AuthContext";
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
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
                                <View style={{ marginTop: 12, marginHorizontal: 24, marginBottom: 64, width: '70%' }}>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                                        <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.1)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                                            <Text style={{ ...Typography.default('semiBold'), fontSize: 14, color: 'rgba(0,0,0,0.7)' }}>1</Text>
                                        </View>
                                        <Text style={{ ...Typography.default(), fontSize: 18, color: 'rgba(0,0,0,0.6)' }}>
                                            Install the Happy CLI on your computer
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
                <Image source={require('@/assets/images/happy-otter-2.png')} style={{ width: 200, height: 140 }} />
                <Text style={{ marginTop: 16, textAlign: 'center',fontSize: 24, ...Typography.default('semiBold') }}>
                Happy Coder is a{'\n'} Claude Code mobile client.
                </Text>
                <Text style={{ ...Typography.default(), fontSize: 18, color: 'rgba(0,0,0,0.6)', marginTop: 16, textAlign: 'center', marginHorizontal: 24, marginBottom: 64 }}>
                    End-to-end encrypted and your account is stored only on your device.
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
            <MaterialIcons name="info-outline" size={24} color="#000" />
        </Pressable>
    );
}