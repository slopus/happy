import { RoundButton } from "@/components/RoundButton";
import { useAuth } from "@/auth/AuthContext";
import { Platform } from "react-native";
import * as React from 'react';
import { encodeBase64 } from "@/encryption/base64";
import { authGetToken } from "@/auth/authGetToken";
import { useRouter } from "expo-router";
import { getRandomBytesAsync } from "expo-crypto";
import { trackAccountCreated, trackAccountRestored } from '@/track';
import { HomeHeaderNotAuth } from "@/components/HomeHeader";
import { MainView } from "@/components/MainView";
import { OnboardingLinkComputer } from "@/components/onboarding/LinkComputer";
import { OnboardingScreen } from "@/components/onboarding/OnboardingScreen";
import { WelcomeContent } from "@/components/onboarding/OnboardingContent";
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
    // Native phones and tablets therefore share the same link screen. Web
    // and desktop retain their existing account-linking flow.
    const showInstallStep = shouldShowFirstRunInstall({
        isAuthenticated: true,
        isDataReady,
        machineCount: machines.length,
        isWeb: Platform.OS === 'web',
        isRunningOnMac: isRunningOnMac(),
    });
    if (showInstallStep) {
        return <OnboardingLinkComputer />;
    }
    return <MainView variant="phone" />;
}

function NotAuthenticated() {
    const auth = useAuth();
    const router = useRouter();
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

    // One filled action and one quiet text action underneath it. On a phone
    // the restore path is rare, so it reads as a footnote; in a browser the
    // usual way in is an account that already lives on a phone.
    return (
        <OnboardingScreen
            header={<HomeHeaderNotAuth />}
            content={<WelcomeContent />}
            primary={isMobile ? (
                <RoundButton title={t('onboarding.createAccount')} action={createAccount} />
            ) : (
                <RoundButton title={t('welcome.loginWithMobileApp')} onPress={openRestore} />
            )}
            secondary={isMobile
                ? { title: t('onboarding.restoreExisting'), onPress: openRestore }
                : { title: t('welcome.createAccount'), action: createAccount }}
        />
    );
}
