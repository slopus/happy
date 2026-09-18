import * as React from 'react';
import { Linking, Platform, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '../RoundButton';
import { OnboardingHeader } from './OnboardingHeader';
import { t } from '@/text';

const DESKTOP_URL = 'https://happy.engineering';

/**
 * Step 2 of the first run: get Happy onto the computer. Shown at the home
 * route once the account exists and no machine has been linked yet, in place
 * of the session list and its dock.
 */
export const OnboardingInstall = React.memo(function OnboardingInstall() {
    const router = useRouter();
    const [useTerminal, setUseTerminal] = React.useState(false);

    return (
        <View style={styles.root}>
            <OnboardingHeader step={2} />
            <View style={styles.content}>
                <Text style={styles.title}>{t('onboarding.installTitle')}</Text>
                {useTerminal ? (
                    <View style={styles.terminalBlock}>
                        <Text style={[styles.terminalText, styles.terminalTextFirst]} selectable>$ npm i -g happy</Text>
                        <Text style={styles.terminalText} selectable>$ happy</Text>
                    </View>
                ) : (
                    <Text style={styles.body}>
                        {t('onboarding.installBodyPrefix')}
                        <Text
                            style={styles.bodyLink}
                            accessibilityRole="link"
                            onPress={() => { void Linking.openURL(DESKTOP_URL); }}
                        >
                            {t('onboarding.installBodyLink')}
                        </Text>
                        {t('onboarding.installBodySuffix')}
                    </Text>
                )}
                <View style={styles.buttonContainer}>
                    <RoundButton
                        title={useTerminal ? t('onboarding.continue') : t('onboarding.installedDesktop')}
                        onPress={() => router.push('/onboarding/scan')}
                    />
                </View>
                <View style={styles.buttonContainer}>
                    <RoundButton
                        size="normal"
                        display="inverted"
                        title={useTerminal ? t('onboarding.useDesktop') : t('onboarding.useTerminal')}
                        onPress={() => setUseTerminal((value) => !value)}
                    />
                </View>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    content: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 32,
        paddingBottom: 48,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 24,
        lineHeight: 30,
        color: theme.colors.text,
        textAlign: 'center',
        marginBottom: 12,
    },
    body: {
        ...Typography.default(),
        fontSize: 17,
        lineHeight: 22,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginBottom: 40,
    },
    bodyLink: {
        color: theme.colors.text,
        textDecorationLine: 'underline',
    },
    terminalBlock: {
        alignSelf: 'stretch',
        backgroundColor: Platform.select({ web: theme.colors.surfaceHighest, default: theme.colors.surfaceHigh }),
        borderRadius: 12,
        paddingVertical: 16,
        paddingHorizontal: 20,
        marginTop: 4,
        marginBottom: 40,
    },
    terminalText: {
        ...Typography.mono(),
        fontSize: 15,
        lineHeight: 22,
        color: theme.colors.text,
    },
    terminalTextFirst: {
        marginBottom: 4,
    },
    buttonContainer: {
        width: 280,
        maxWidth: '100%',
        marginBottom: 8,
    },
}));
