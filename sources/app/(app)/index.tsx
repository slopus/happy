import { RoundButton } from "@/components/RoundButton";
import { useAuth } from "@/auth/AuthContext";
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as React from 'react';
import { encodeBase64 } from "@/auth/base64";
import { authGetToken } from "@/auth/authGetToken";
import { useUpdates } from "@/hooks/useUpdates";
import { UpdateBanner } from "@/components/UpdateBanner";
import { SessionsList } from "@/components/SessionsList";
import { Stack, useRouter } from "expo-router";
import { useSessions } from "@/sync/storage";
import { getRandomBytesAsync } from "expo-crypto";
import { useIsTablet, useIsLandscape } from "@/utils/responsive";
import { Typography } from "@/constants/Typography";
import { EmptyMainScreen } from "@/components/EmptyMainScreen";
import { trackAccountCreated, trackAccountRestored } from '@/track';

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
                <View style={{ flex: 1, flexBasis: 0, flexGrow: 1 }}>
                    {sessionsData === null && (
                        <View style={{ flex: 1, flexBasis: 0, flexGrow: 1, justifyContent: 'center', alignItems: 'center' }}>
                            <ActivityIndicator />
                        </View>
                    )}
                    {sessionsData !== null && sessionsData.length === 0 && (
                        <EmptyMainScreen />
                    )}
                </View>
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

    const emptyState = <EmptyMainScreen />;

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
    const isLandscape = useIsLandscape();
    const insets = useSafeAreaInsets();

    const createAccount = async () => {
        const secret = await getRandomBytesAsync(32);
        const token = await authGetToken(secret);
        if (token && secret) {
            await auth.login(token, encodeBase64(secret, 'base64url'));
            trackAccountCreated();
        }
    }

    const portraitLayout = (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Image source={require('@/assets/images/happy-otter-2.png')} style={{ width: 200, height: 140 }} />
            <Text style={{ marginTop: 16, textAlign: 'center', fontSize: 24, ...Typography.default('semiBold') }}>
                Claude Code mobile client
            </Text>
            <Text style={{ ...Typography.default(), fontSize: 18, color: 'rgba(0,0,0,0.6)', marginTop: 16, textAlign: 'center', marginHorizontal: 24, marginBottom: 64 }}>
                End-to-end encrypted and your account is stored only on your device.
            </Text>
            <View style={{ maxWidth: 200, width: '100%', marginBottom: 16 }}>
                <RoundButton
                    title="Create account"
                    action={createAccount}
                />
            </View>
            <View style={{ maxWidth: 200, width: '100%' }}>
                <RoundButton
                    size="normal"
                    title="Restore account"
                    onPress={() => {
                        trackAccountRestored();
                        router.push('/restore');
                    }}
                    display="inverted"
                />
            </View>
        </View>
    );

    const landscapeLayout = (
        <View style={{
            flexBasis: 0,
            flexGrow: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 48,
            paddingBottom: insets.bottom + 24
        }}>
            <View style={{ flexGrow: 1, flexBasis: 0, maxWidth: 800, flexDirection: 'row' }}>
                <View style={{
                    flexBasis: 0, flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingRight: 24
                }}>
                    <Image source={require('@/assets/images/happy-otter-2.png')} style={{ width: 200, height: 140 }} />
                </View>
                <View style={{
                    flexBasis: 0,
                    flexGrow: 1,
                    alignItems: 'center',
                    justifyContent: 'center',
                    paddingLeft: 24
                }}>
                    <Text style={{ textAlign: 'center', fontSize: 24, ...Typography.default('semiBold') }}>
                        Claude Code mobile client
                    </Text>
                    <Text style={{ ...Typography.default(), fontSize: 18, color: 'rgba(0,0,0,0.6)', marginTop: 16, textAlign: 'center', marginBottom: 32, paddingHorizontal: 16 }}>
                        End-to-end encrypted and your account is stored only on your device.
                    </Text>
                    <View style={{ width: 240, marginBottom: 16 }}>
                        <RoundButton
                            title="Create account"
                            action={createAccount}
                        />
                    </View>
                    <View style={{ width: 240 }}>
                        <RoundButton
                            size="normal"
                            title="Restore account"
                            onPress={() => {
                                trackAccountRestored();
                                router.push('/restore');
                            }}
                            display="inverted"
                        />
                    </View>
                </View>
            </View>
        </View>
    );

    return (
        <>
            <Stack.Screen
                options={{
                    headerRight: () => null
                }}
            />
            {isLandscape ? landscapeLayout : portraitLayout}
        </>
    )
}

function HeaderRight() {
    const router = useRouter();

    return (
        <Pressable
            onPress={() => router.push('/settings')}
            hitSlop={10}
            style={{ marginRight: 16 }}
        >
            <Ionicons name="settings-outline" size={24} color="#000" />
        </Pressable>
    );
}