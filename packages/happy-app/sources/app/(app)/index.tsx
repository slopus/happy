import { RoundButton } from "@/components/RoundButton";
import { useAuth } from "@/auth/AuthContext";
import { Text, View, Image, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as React from 'react';
import { encodeBase64 } from "@/encryption/base64";
import { authGetToken } from "@/auth/authGetToken";
import { useRouter } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { getRandomBytesAsync } from "expo-crypto";
import { useIsLandscape } from "@/utils/responsive";
import { Typography } from "@/constants/Typography";
import { trackAccountCreated, trackAccountRestored } from '@/track';
import { HomeHeaderNotAuth } from "@/components/HomeHeader";
import { MainView } from "@/components/MainView";
import { OnboardingInstall } from "@/components/onboarding/OnboardingInstall";
import { shouldShowFirstRunInstall } from "@/components/onboarding/firstRunOnboarding";
import { useAllMachines, useIsDataReady } from "@/sync/storage";
import { t } from '@/text';
import { isRunningOnMac } from '@/utils/platform';

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
    const isDataReady = useIsDataReady();
    const machines = useAllMachines({ includeOffline: true });
    // Until a computer is linked there is nothing for the home chrome to do:
    // the dock, filters, session list, and tablet sidebar all need a machine.
    // Native phones and tablets therefore share the same install step. Web
    // and desktop retain their existing account-linking flow.
    const showInstallStep = shouldShowFirstRunInstall({
        isAuthenticated: true,
        isDataReady,
        machineCount: machines.length,
        isWeb: Platform.OS === 'web',
        isRunningOnMac: isRunningOnMac(),
    });
    if (showInstallStep) {
        return <OnboardingInstall />;
    }
    return <MainView variant="phone" />;
}

function NotAuthenticated() {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const router = useRouter();
    const isLandscape = useIsLandscape();
    const insets = useSafeAreaInsets();
    const isMobile = Platform.OS === 'android' || Platform.OS === 'ios';

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

    const openRestore = () => {
        trackAccountRestored();
        router.push('/restore');
    };

    // One filled action and one quiet text action underneath it. The restore
    // path is rare, so it reads as a footnote rather than a second button.
    const actions = isMobile ? (
        <>
            <View style={styles.buttonContainer}>
                <RoundButton
                    title={t('onboarding.getStarted')}
                    action={createAccount}
                />
            </View>
            <View style={styles.buttonContainerSecondary}>
                <RoundButton
                    size="normal"
                    title={t('onboarding.restoreExisting')}
                    onPress={openRestore}
                    display="inverted"
                />
            </View>
        </>
    ) : (
        <>
            <View style={styles.buttonContainer}>
                <RoundButton
                    title={t('welcome.loginWithMobileApp')}
                    onPress={openRestore}
                />
            </View>
            <View style={styles.buttonContainerSecondary}>
                <RoundButton
                    size="normal"
                    title={t('welcome.createAccount')}
                    action={createAccount}
                    display="inverted"
                />
            </View>
        </>
    );

    const logo = (
        <Image
            source={theme.dark ? require('@/assets/images/logotype-light.png') : require('@/assets/images/logotype-dark.png')}
            resizeMode="contain"
            style={styles.logo}
        />
    );

    const portraitLayout = (
        <View style={styles.portraitContainer}>
            {logo}
            <Text style={styles.title}>
                {t('onboarding.headline')}
            </Text>
            <Text style={styles.subtitle}>
                {t('onboarding.tagline')}
            </Text>
            {actions}
        </View>
    );

    const landscapeLayout = (
        <View style={[styles.landscapeContainer, { paddingBottom: insets.bottom + 24 }]}>
            <View style={styles.landscapeInner}>
                <View style={styles.landscapeLogoSection}>
                    {logo}
                </View>
                <View style={styles.landscapeContentSection}>
                    <Text style={styles.landscapeTitle}>
                        {t('onboarding.headline')}
                    </Text>
                    <Text style={styles.landscapeSubtitle}>
                        {t('onboarding.tagline')}
                    </Text>
                    {actions}
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
    // NotAuthenticated styles
    portraitContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 32,
    },
    logo: {
        width: 300,
        height: 90,
    },
    title: {
        marginTop: 16,
        textAlign: 'center',
        fontSize: 24,
        lineHeight: 30,
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: 17,
        lineHeight: 22,
        color: theme.colors.textSecondary,
        marginTop: 12,
        textAlign: 'center',
        marginBottom: 48,
    },
    buttonContainer: {
        width: 280,
        maxWidth: '100%',
        marginBottom: 8,
    },
    buttonContainerSecondary: {
        width: 280,
        maxWidth: '100%',
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
        lineHeight: 30,
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    landscapeSubtitle: {
        ...Typography.default(),
        fontSize: 17,
        lineHeight: 22,
        color: theme.colors.textSecondary,
        marginTop: 12,
        textAlign: 'center',
        marginBottom: 32,
        paddingHorizontal: 16,
    },
}));
