import * as React from 'react';
import { Platform, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Header } from '../navigation/Header';
import { t } from '@/text';

export const ONBOARDING_STEP_COUNT = 3;

/**
 * Plain step counter for the first-run screens. No logo, no socket status:
 * before an account exists there is no socket, and a red "disconnected" line
 * on the welcome screen read as a fault. A custom server hostname still shows
 * underneath, since self-hosters need to see where they are pointed.
 */
export const OnboardingStepTitle = React.memo(function OnboardingStepTitle({
    step,
    subtitle,
}: {
    step: number;
    subtitle?: string;
}) {
    return (
        <View style={styles.container} pointerEvents="none">
            <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
                {t('onboarding.step', { step, total: ONBOARDING_STEP_COUNT })}
            </Text>
            {subtitle ? (
                <Text style={styles.subtitle} numberOfLines={1} ellipsizeMode="middle">{subtitle}</Text>
            ) : null}
        </View>
    );
});

export const OnboardingHeader = React.memo(function OnboardingHeader({
    step,
    subtitle,
    headerRight,
}: {
    step: number;
    subtitle?: string;
    headerRight?: () => React.ReactNode;
}) {
    const { theme } = useUnistyles();
    return (
        <Header
            title={<OnboardingStepTitle step={step} subtitle={subtitle} />}
            headerRight={headerRight}
            headerShadowVisible={false}
            headerBackgroundColor={theme.colors.groupped.background}
            mobileTitleSurface="plain"
            mobileTitleAlignment="center"
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        alignSelf: 'stretch',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 0,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: Platform.OS === 'web' ? 17 : 16,
        fontWeight: '600',
        lineHeight: 20,
        color: theme.colors.header.tint,
        textAlign: 'center',
    },
    subtitle: {
        ...Typography.default(),
        fontSize: 11,
        fontWeight: '500',
        lineHeight: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        maxWidth: '100%',
    },
}));
