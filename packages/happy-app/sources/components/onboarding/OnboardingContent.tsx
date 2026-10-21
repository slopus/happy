import * as React from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { HappyEngineeringWordmark } from './HappyEngineeringWordmark';

const DESKTOP_URL = 'https://happy.engineering';
const WORDMARK_HEIGHT = 84;
/**
 * The titles are already large, so like the system's own large titles they
 * grow less than body text does. Without it "Link Your Computer" breaks onto
 * a second line on a small phone at a larger text size.
 */
const TITLE_MAX_SCALE = 1.2;

/**
 * What sits above the actions on the two first-run screens. Both are plain
 * views of their props so OnboardingScreen can lay an invisible copy of each
 * under whichever is showing, and reserve room for the taller of the two.
 */

export const WelcomeContent = React.memo(function WelcomeContent() {
    return (
        <View>
            <HappyEngineeringWordmark height={WORDMARK_HEIGHT} />
            <Text style={[styles.title, styles.welcomeTitle]} maxFontSizeMultiplier={TITLE_MAX_SCALE} accessibilityRole="header">
                {t('onboarding.headline')}
            </Text>
            <View style={styles.props}>
                <Text style={styles.prop}>{t('onboarding.propEncrypted')}</Text>
                <Text style={styles.prop}>{t('onboarding.propNoPassword')}</Text>
                <Text style={styles.prop}>{t('onboarding.propOpenSource')}</Text>
            </View>
        </View>
    );
});

export type LinkChecklistStep = 'install' | 'open';

/**
 * The link checklist and the line under it that reports a failed link. The
 * line keeps its height when empty, so an error never moves the buttons.
 */
export const LinkComputerContent = React.memo(function LinkComputerContent({
    ticked,
    onToggle,
    disabled = false,
    error,
}: {
    ticked: Partial<Record<LinkChecklistStep, boolean>>;
    /** Rows without it are read-only. */
    onToggle?: (step: LinkChecklistStep) => void;
    disabled?: boolean;
    error?: string | null;
}) {
    const openDesktopSite = React.useCallback(() => {
        void Linking.openURL(DESKTOP_URL);
    }, []);
    return (
        <View>
            <Text style={styles.title} maxFontSizeMultiplier={TITLE_MAX_SCALE} accessibilityRole="header">
                {t('onboarding.linkTitle')}
            </Text>
            <View style={styles.checklist}>
                <ChecklistRow
                    checked={!!ticked.install}
                    title={t('onboarding.installStep')}
                    onToggle={onToggle ? () => onToggle('install') : undefined}
                    disabled={disabled}
                >
                    <Text style={styles.body}>
                        {t('onboarding.installBodyPrefix')}
                        <Text
                            style={styles.link}
                            accessibilityRole={onToggle ? 'link' : undefined}
                            onPress={onToggle ? openDesktopSite : undefined}
                        >
                            {t('onboarding.installBodyLink')}
                        </Text>
                        {t('onboarding.installBodySuffix')}
                    </Text>
                </ChecklistRow>
                <ChecklistRow
                    checked={!!ticked.open}
                    title={t('onboarding.openStep')}
                    onToggle={onToggle ? () => onToggle('open') : undefined}
                    disabled={disabled}
                    last
                >
                    <Text style={styles.body}>{t('onboarding.openBody')}</Text>
                </ChecklistRow>
            </View>
            <Text
                style={styles.error}
                numberOfLines={1}
                accessibilityLiveRegion="polite"
                accessibilityElementsHidden={!error}
                importantForAccessibility={error ? 'auto' : 'no-hide-descendants'}
            >
                {/* A no-break space holds one line of height while there is no error. */}
                {error || '\u00a0'}
            </Text>
        </View>
    );
});

type ChecklistRowProps = {
    checked: boolean;
    title: React.ReactNode;
    /** Tapping the row toggles it. Rows without this are read-only. */
    onToggle?: () => void;
    disabled?: boolean;
    /** Drops the gap under the row. */
    last?: boolean;
    /** Stays visible when the completion checkbox changes. */
    children?: React.ReactNode;
};

/**
 * Completion changes only the checkbox; instructions and layout stay put.
 */
export const ChecklistRow = React.memo(function ChecklistRow({
    checked,
    title,
    onToggle,
    disabled = false,
    last = false,
    children,
}: ChecklistRowProps) {
    const { theme } = useUnistyles();
    return (
        <View style={last ? undefined : styles.row}>
            <Pressable
                onPress={onToggle}
                disabled={disabled || !onToggle}
                accessibilityRole={onToggle ? 'checkbox' : undefined}
                accessibilityState={onToggle ? { checked, disabled } : undefined}
                hitSlop={8}
                style={styles.rowHead}
            >
                <View style={styles.box}>
                    <Ionicons
                        name={checked ? 'checkmark-circle' : 'ellipse-outline'}
                        size={26}
                        color={checked ? theme.colors.success : theme.colors.textSecondary}
                    />
                </View>
                <Text style={styles.rowTitle}>{title}</Text>
            </Pressable>
            {children ? (
                <View style={styles.rowBody}>{children}</View>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    // One title style for both screens: the welcome headline and "Link Your
    // Computer" read as the same element in the same place.
    title: {
        ...Typography.default('semiBold'),
        fontSize: 28,
        lineHeight: 34,
        color: theme.colors.text,
    },
    welcomeTitle: {
        marginTop: 28,
    },
    props: {
        marginTop: 12,
        paddingBottom: 12,
    },
    prop: {
        ...Typography.default(),
        fontSize: 17,
        lineHeight: 24,
        color: theme.colors.textSecondary,
    },
    checklist: {
        marginTop: 24,
    },
    row: {
        marginBottom: 20,
    },
    rowHead: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 32,
    },
    box: {
        width: 26,
        height: 26,
        alignItems: 'center',
        justifyContent: 'center',
    },
    rowTitle: {
        ...Typography.default('semiBold'),
        flex: 1,
        fontSize: 17,
        lineHeight: 22,
        color: theme.colors.text,
    },
    rowBody: {
        paddingLeft: 38,
        paddingTop: 6,
    },
    body: {
        ...Typography.default(),
        fontSize: 15,
        lineHeight: 21,
        color: theme.colors.textSecondary,
    },
    link: {
        color: theme.colors.text,
        textDecorationLine: 'underline',
    },
    error: {
        ...Typography.default(),
        marginTop: 16,
        fontSize: 15,
        lineHeight: 20,
        textAlign: 'center',
        color: theme.colors.warningCritical,
    },
}));
