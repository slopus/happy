import { RoundButton } from "@/components/RoundButton";
import { useAuth } from "@/auth/AuthContext";
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Image, Platform, Pressable, Text, View } from "react-native";
import * as React from 'react';
import { encodeBase64 } from "@/auth/base64";
import { authGetToken } from "@/auth/authGetToken";
import { useUpdates } from "@/hooks/useUpdates";
import { UpdateBanner } from "@/components/UpdateBanner";
import { SessionsList } from "@/components/SessionsList";
import { Stack, useRouter } from "expo-router";
import { useSessions } from "@/sync/storage";
import { getRandomBytesAsync } from "expo-crypto";
import { ConnectButton } from "@/components/ConnectButton";
import { useIsTablet } from "@/utils/responsive";
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
    const isTablet = useIsTablet();
    const router = useRouter();

    // Empty state in tabled view
    if (isTablet) {
        return (
            <>
                <Stack.Screen
                    options={{
                        headerShown: false
                    }}
                />
                <View />
            </>
        )
    }

    if (sessionsData === null) {
        return (
            <View className="flex-1 items-center justify-center mb-8">
                <ActivityIndicator size="small" color="#000000" />
            </View>
        )
    }

    const emptyState = (
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
                    <View style={{ marginTop: 12, marginHorizontal: 24, marginBottom: 64, width: 250 }}>
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
                    <ConnectButton />
                </>
            )}
        </View>
    );

    // On phones, use the existing navigation pattern
    return (
        <>
            <Stack.Screen
                options={{
                    headerRight: () => <HeaderRight />
                }}
            />
            <View className="flex-1">
                {updateAvailable && <UpdateBanner onReload={reloadApp} />}
                {sessionsData.length === 0 ? emptyState : (
                    <SessionsList
                        data={sessionsData}
                        onSessionPress={(sessionId) => router.push(`/session/${sessionId}`)}
                    />
                )}
            </View>
        </>
    );
}

function NotAuthenticated() {
    const auth = useAuth();
    const router = useRouter();

    const createAccount = async () => {
        const secret = await getRandomBytesAsync(32);
        const token = await authGetToken(secret);
        if (token && secret) {
            await auth.login(token, encodeBase64(secret, 'base64url'));
        }
    }

    return (
        <>
            <Stack.Screen
                options={{
                    headerRight: () => null
                }}
            />
            <View className="flex-1 items-center justify-center">
                <Image source={require('@/assets/images/happy-otter-2.png')} style={{ width: 200, height: 140 }} />
                <Text style={{ marginTop: 16, textAlign: 'center', fontSize: 24, ...Typography.default('semiBold') }}>
                    Claude Code mobile client.
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
                <View className="max-w-[200px] w-full pt-4">
                    <RoundButton
                        size="normal"
                        title="Restore account"
                        onPress={() => router.push('/restore')}
                        display="inverted"
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
            onPress={() => router.push('/settings')}
            hitSlop={10}
        >
            <Ionicons name="settings-outline" size={24} color="#000" />
        </Pressable>
    );
}