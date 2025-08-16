import { RoundButton } from "@/components/RoundButton";
import { useAuth } from "@/auth/AuthContext";
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Image, Pressable, Text, View, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as React from 'react';
import { encodeBase64 } from "@/auth/base64";
import { authGetToken } from "@/auth/authGetToken";
import { useUpdates } from "@/hooks/useUpdates";
import { UpdateBanner } from "@/components/UpdateBanner";
import { SessionsList } from "@/components/SessionsList";
import { router, Stack, useRouter } from "expo-router";
import { useSessionListViewData, useEntitlement, useSocketStatus, useSetting } from "@/sync/storage";
import { getRandomBytesAsync } from "expo-crypto";
import { useIsTablet, useIsLandscape } from "@/utils/responsive";
import { Typography } from "@/constants/Typography";
import { EmptyMainScreen } from "@/components/EmptyMainScreen";
import { trackAccountCreated, trackAccountRestored } from '@/track';
import { getServerInfo } from "@/sync/serverConfig";
import { FAB } from "@/components/FAB";
import { Header } from "@/components/navigation/Header";
import { HomeHeader, HomeHeaderNotAuth } from "@/components/HomeHeader";
import { Modal } from '@/modal';
import * as Clipboard from 'expo-clipboard';

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
    const sessionListViewData = useSessionListViewData();
    const { updateAvailable, reloadApp } = useUpdates();
    const isTablet = useIsTablet();
    const isExperimental = useSetting('experiments');

    const handleNewSession = () => {
        router.push('/new-session');
    }

    // Empty state in tabled view
    if (isTablet) {
        return (
            <>
                <View style={{ flex: 1, flexBasis: 0, flexGrow: 1 }}>
                    {sessionListViewData === null && (
                        <View style={{ flex: 1, flexBasis: 0, flexGrow: 1, justifyContent: 'center', alignItems: 'center' }}>
                            <ActivityIndicator />
                        </View>
                    )}
                    {sessionListViewData !== null && sessionListViewData.length === 0 && (
                        <EmptyMainScreen />
                    )}
                </View>
            </>
        )
    }

    if (sessionListViewData === null) {
        return (
            <>
                <HomeHeader />
                <View className="flex-1 items-center justify-center mb-8">
                    <ActivityIndicator size="small" color="#000000" />
                </View>
                {isExperimental && (
                    <FAB onPress={handleNewSession} />
                )}
            </>
        )
    }

    const emptyState = <EmptyMainScreen />;

    // On phones, use the existing navigation pattern
    return (
        <>
            <HomeHeader />
            <View className="flex-1">
                {updateAvailable && <UpdateBanner onReload={reloadApp} />}
                {!sessionListViewData || sessionListViewData.length === 0 ? emptyState : (
                    <SessionsList />
                )}
            </View>
            {isExperimental && (
                <FAB onPress={handleNewSession} />
            )}
        </>
    );
}

function NotAuthenticated() {
    const auth = useAuth();
    const router = useRouter();
    const isLandscape = useIsLandscape();
    const insets = useSafeAreaInsets();

    const createAccount = async () => {
        try {
            const secret = await getRandomBytesAsync(32);
            const token = await authGetToken(secret);
            if (token && secret) {
                await auth.login(token, encodeBase64(secret, 'base64url'));
                trackAccountCreated();
            }
        } catch (error) {
            console.error('Error creating account', error);
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
            <HomeHeaderNotAuth />
            {isLandscape ? landscapeLayout : portraitLayout}
        </>
    )
}