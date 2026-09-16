import * as React from 'react';
import { Header } from './navigation/Header';
import { Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useSegments } from 'expo-router';
import { getServerInfo } from '@/sync/serverConfig';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { ShortcutHintBadge, useShortcutHints } from './ShortcutHints';
import { HomeHeaderTitle } from './HomeHeaderTitle';
import { OnboardingHeader } from './onboarding/OnboardingHeader';

const HEADER_LOGO_SIZE = 19;

const stylesheet = StyleSheet.create((theme, runtime) => ({
    headerButton: {
        // marginHorizontal: 4,
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerButtonShortcutActive: {
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceSelected,
    },
    headerShortcutBadge: {
        position: 'absolute',
        top: -8,
        right: -12,
    },
    iconButton: {
        color: theme.colors.header.tint,
    },
    logoContainer: {
        // marginHorizontal: 4,
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
        tintColor: theme.colors.header.tint,
    },
}));


export const HomeHeader = React.memo(() => {
    const { theme } = useUnistyles();
    const header = (
        <Header
            title={<HomeHeaderTitle title={t('sidebar.sessionsTitle')} />}
            headerRight={() => <HeaderRight />}
            headerLeft={() => <HeaderLeft />}
            headerLeftGlass={Platform.OS !== 'web'}
            headerShadowVisible={false}
            headerTransparent={true}
            mobileTitleSurface="plain"
            mobileTitleAlignment="center"
        />
    );

    return Platform.OS === 'web'
        ? <View style={{ backgroundColor: theme.colors.groupped.background }}>{header}</View>
        : header;
})

/**
 * Step 1 of the first run. No logo and no socket status: nothing is connected
 * yet, so the only chrome is the step counter and the server settings action.
 */
export const HomeHeaderNotAuth = React.memo(() => {
    useSegments(); // Re-rendered automatically when screen navigates back
    const serverInfo = getServerInfo();
    return (
        <OnboardingHeader
            step={1}
            subtitle={serverInfo.isCustom ? serverInfo.hostname + (serverInfo.port ? `:${serverInfo.port}` : '') : undefined}
            headerRight={() => <HeaderRightNotAuth />}
        />
    )
});

function HeaderRight() {
    const router = useRouter();
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { visible: shortcutHintsVisible } = useShortcutHints();

    return (
        <Pressable
            onPress={() => router.navigate('/new')}
            hitSlop={15}
            style={[
                styles.headerButton,
                shortcutHintsVisible && styles.headerButtonShortcutActive,
            ]}
        >
            <Ionicons name="add-outline" size={28} color={theme.colors.header.tint} />
            <ShortcutHintBadge shortcutKey="N" style={styles.headerShortcutBadge} />
        </Pressable>
    );
}

function HeaderRightNotAuth() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const styles = stylesheet;

    // Same gear the signed-in home uses: this is a settings action, and the
    // server-rack glyph named an object most people have never seen.
    return (
        <Pressable
            onPress={() => router.push('/server')}
            hitSlop={15}
            accessibilityRole="button"
            accessibilityLabel={t('server.title')}
            style={styles.headerButton}
        >
            <Ionicons name="settings-outline" size={22} color={theme.colors.header.tint} />
        </Pressable>
    );
}

function HeaderLeft() {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <View style={styles.logoContainer}>
            <Image
                source={require('@/assets/images/logo-black.png')}
                contentFit="contain"
                style={{ width: HEADER_LOGO_SIZE, height: HEADER_LOGO_SIZE }}
                tintColor={theme.colors.header.tint}
            />
        </View>
    );
}
