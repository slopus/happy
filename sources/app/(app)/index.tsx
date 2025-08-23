import { RoundButton } from "@/components/RoundButton";
import { useAuth } from "@/auth/AuthContext";
import { ActivityIndicator, Text, View, Image } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as React from 'react';
import { encodeBase64 } from "@/auth/base64";
import { authGetToken } from "@/auth/authGetToken";
import { useUpdates } from "@/hooks/useUpdates";
import { UpdateBanner } from "@/components/UpdateBanner";
import { SessionsList } from "@/components/SessionsList";
import { router, Stack, useRouter } from "expo-router";
import { useSessionListViewData, useEntitlement, useSocketStatus, useSetting } from "@/sync/storage";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { getRandomBytesAsync } from "expo-crypto";
import { useIsTablet, useIsLandscape } from "@/utils/responsive";
import { Typography } from "@/constants/Typography";
import { EmptyMainScreen } from "@/components/EmptyMainScreen";
import { trackAccountCreated, trackAccountRestored } from '@/track';
import { FAB } from "@/components/FAB";
import { HomeHeader, HomeHeaderNotAuth } from "@/components/HomeHeader";
import { VoiceAssistantStatusBar } from '@/components/VoiceAssistantStatusBar';
import { useRealtimeStatus } from '@/sync/storage';

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
    const { theme } = useUnistyles();
    let sessionListViewData = useSessionListViewData();
    const { updateAvailable, reloadApp } = useUpdates();
    const isTablet = useIsTablet();
    const isExperimental = useSetting('experiments');
    const realtimeStatus = useRealtimeStatus();

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
                            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
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
                {!isTablet && realtimeStatus !== 'disconnected' && (
                    <VoiceAssistantStatusBar variant="full" />
                )}
                <View style={styles.loadingContainerWrapper}>
                    <UpdateBanner />
                    <View style={styles.loadingContainer}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                </View>
                {isExperimental && (
                    <FAB onPress={handleNewSession} />
                )}
            </>
        )
    }

    const emptyState = (
        <View style={{ flex: 1, flexBasis: 0, flexGrow: 1, flexDirection: 'column', backgroundColor: theme.colors.groupped.background }}>
            <UpdateBanner />
            <View style={{ flex: 1, flexBasis: 0, flexGrow: 1 }}>
                <EmptyMainScreen />
            </View>
        </View>
    );

    // On phones, use the existing navigation pattern
    return (
        <>
            <HomeHeader />
            {!isTablet && realtimeStatus !== 'disconnected' && (
                <VoiceAssistantStatusBar variant="full" />
            )}
            <View style={styles.container}>
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
    const { theme } = useUnistyles();
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
        <View style={styles.portraitContainer}>
            <Image
                source={theme.dark ? require('@/assets/images/logotype-light.png') : require('@/assets/images/logotype-dark.png')}
                resizeMode="contain"
                style={styles.logo}
            />
            <Text style={styles.title}>
                Claude Code mobile client
            </Text>
            <Text style={styles.subtitle}>
                End-to-end encrypted and your account is stored only on your device.
            </Text>
            <View style={styles.buttonContainer}>
                <RoundButton
                    title="Create account"
                    action={createAccount}
                />
            </View>
            <View style={styles.buttonContainerSecondary}>
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
        <View style={[styles.landscapeContainer, { paddingBottom: insets.bottom + 24 }]}>
            <View style={styles.landscapeInner}>
                <View style={styles.landscapeLogoSection}>
                    <Image
                        source={theme.dark ? require('@/assets/images/logotype-light.png') : require('@/assets/images/logotype-dark.png')}
                        resizeMode="contain"
                        style={styles.logo}
                    />
                </View>
                <View style={styles.landscapeContentSection}>
                    <Text style={styles.landscapeTitle}>
                        Claude Code mobile client
                    </Text>
                    <Text style={styles.landscapeSubtitle}>
                        End-to-end encrypted and your account is stored only on your device.
                    </Text>
                    <View style={styles.landscapeButtonContainer}>
                        <RoundButton
                            title="Create account"
                            action={createAccount}
                        />
                    </View>
                    <View style={styles.landscapeButtonContainerSecondary}>
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

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1
    },
    loadingContainerWrapper: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    loadingContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingBottom: 32,
    },
    // NotAuthenticated styles
    portraitContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    logo: {
        width: 300,
        height: 90,
    },
    title: {
        marginTop: 16,
        textAlign: 'center',
        fontSize: 24,
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: 18,
        color: theme.colors.textSecondary,
        marginTop: 16,
        textAlign: 'center',
        marginHorizontal: 24,
        marginBottom: 64,
    },
    buttonContainer: {
        maxWidth: 200,
        width: '100%',
        marginBottom: 16,
    },
    buttonContainerSecondary: {
        maxWidth: 200,
        width: '100%',
    },
    // Landscape styles
    landscapeContainer: {
        flexBasis: 0,
        flexGrow: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 48,
    },
    landscapeInner: {
        flexGrow: 1,
        flexBasis: 0,
        maxWidth: 800,
        flexDirection: 'row',
    },
    landscapeLogoSection: {
        flexBasis: 0,
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingRight: 24,
    },
    landscapeContentSection: {
        flexBasis: 0,
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingLeft: 24,
    },
    landscapeTitle: {
        textAlign: 'center',
        fontSize: 24,
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    landscapeSubtitle: {
        ...Typography.default(),
        fontSize: 18,
        color: theme.colors.textSecondary,
        marginTop: 16,
        textAlign: 'center',
        marginBottom: 32,
        paddingHorizontal: 16,
    },
    landscapeButtonContainer: {
        width: 240,
        marginBottom: 16,
    },
    landscapeButtonContainerSecondary: {
        width: 240,
    },
}));