import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { RoundButton } from '../RoundButton';
import { LinkComputerContent, WelcomeContent } from './OnboardingContent';

/**
 * The template both first-run screens are built from, so that moving from
 * Welcome to Link Your Computer changes the words and nothing else:
 *
 *   header   the gear, the same header on both screens
 *   body     one block centred in the space left: [content][primary][secondary]
 *   footer   Get help, bottom right
 *
 * The block is the same height on both screens at any width and text size.
 * Its content slot holds the visible content over invisible copies of both
 * screens' content, and the secondary action holds its label over invisible
 * copies of both screens' labels; each takes the height of its tallest
 * layer. So the top of the content, the primary button and the secondary
 * action land at the same place on both screens without a single measured or
 * hard-coded position. When the block outgrows the screen (very large text)
 * the spacers collapse and the body scrolls from the top; header and footer
 * stay where they are.
 */
export const OnboardingScreen = React.memo(function OnboardingScreen({
    header,
    content,
    primary,
    secondary,
}: {
    /** An OnboardingHeader, so both screens get the same header height. */
    header: React.ReactNode;
    content: React.ReactNode;
    /** A large RoundButton. */
    primary: React.ReactNode;
    secondary: {
        title: string;
        onPress?: () => void;
        action?: () => Promise<void>;
        disabled?: boolean;
    };
}) {
    const insets = useSafeAreaInsets();
    return (
        <View style={styles.root}>
            {header}
            <ScrollView
                style={styles.body}
                contentContainerStyle={styles.bodyContent}
                alwaysBounceVertical={false}
                keyboardShouldPersistTaps="handled"
            >
                <View style={styles.spacer} />
                <View style={styles.block}>
                    <Layers reserve={[<WelcomeContent key="welcome" />, <LinkComputerContent key="link" ticked={{}} />]}>
                        {content}
                    </Layers>
                    <View style={styles.primary}>{primary}</View>
                    <Layers
                        style={styles.secondary}
                        reserve={SECONDARY_TITLES().map((title) => <SecondaryButton key={title} title={title} disabled />)}
                    >
                        <SecondaryButton {...secondary} />
                    </Layers>
                </View>
                <View style={styles.spacer} />
            </ScrollView>
            <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
                <GetHelpButton />
            </View>
        </View>
    );
});

/** Every secondary label the template can show, in the current language. */
const SECONDARY_TITLES = () => [
    t('onboarding.restoreExisting'),
    t('welcome.createAccount'),
    t('onboarding.pasteLink'),
];

/**
 * Lays its children over invisible copies of everything else that can stand
 * in their place, and takes the height of the tallest. The copies are not
 * seen, not read out and not tappable; the visible layer comes last so it is
 * also the one on top.
 */
function Layers({ reserve, style, children }: {
    reserve: React.ReactNode[];
    style?: ViewStyle;
    children: React.ReactNode;
}) {
    return (
        <View style={[styles.layers, style]}>
            {reserve.map((node, i) => (
                <View
                    key={i}
                    style={[styles.layer, styles.reserve, i > 0 && styles.layerOver]}
                    pointerEvents="none"
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    aria-hidden
                >
                    {node}
                </View>
            ))}
            <View style={[styles.layer, styles.layerOver]}>{children}</View>
        </View>
    );
}

function SecondaryButton({ title, onPress, action, disabled }: {
    title: string;
    onPress?: () => void;
    action?: () => Promise<void>;
    disabled?: boolean;
}) {
    return (
        <RoundButton
            size="normal"
            display="inverted"
            title={title}
            onPress={onPress}
            action={action}
            disabled={disabled}
        />
    );
}

/**
 * Where somebody stuck on this screen can turn, and to whom. The same list
 * the desktop app offers during its own setup.
 */
const HELP_ISSUES = { label: () => t('onboarding.helpIssues'), url: 'https://github.com/slopus/happy/issues' };
const HELP_DISCORD = { label: () => t('onboarding.helpDiscord'), url: 'https://discord.gg/fX9WBAhyfD' };
const HELP_LINKS: readonly { label: () => string; url: string }[] = Platform.OS === 'android'
    // Android's native alert shows at most three buttons and drops the rest,
    // Cancel included, so it gets the two public places plus Cancel.
    ? [HELP_DISCORD, HELP_ISSUES]
    : [
        HELP_DISCORD,
        { label: () => t('onboarding.helpBra1nDump'), url: 'https://x.com/bra1n_dump' },
        { label: () => t('onboarding.helpEx3ndr'), url: 'https://x.com/Ex3NDR' },
        HELP_ISSUES,
    ];

/**
 * Somewhere to turn without leaving the step you are stuck on. The options
 * arrive as the app's ordinary alert — a native sheet on a phone, the web
 * modal in a browser — so this adds a corner button, not a new surface.
 */
export const GetHelpButton = React.memo(function GetHelpButton() {
    const { theme } = useUnistyles();

    const openHelp = React.useCallback(() => {
        const links = HELP_LINKS.map((link) => ({
            text: link.label(),
            onPress: () => { void openExternalUrl(link.url); },
        }));
        const cancel = { text: t('common.cancel'), style: 'cancel' as const };
        Modal.alert(
            t('onboarding.getHelp'),
            t('onboarding.helpMessage'),
            // Android fills its slots by position (neutral, negative,
            // positive), so Cancel goes in the middle to land on negative.
            Platform.OS === 'android' ? [links[0], cancel, links[1]] : [...links, cancel],
        );
    }, []);

    return (
        <Pressable
            onPress={openHelp}
            accessibilityRole="button"
            accessibilityLabel={t('onboarding.getHelp')}
            hitSlop={8}
            style={({ pressed }) => [styles.getHelp, pressed && styles.getHelpPressed]}
        >
            <Ionicons name="help-circle-outline" size={17} color={theme.colors.textSecondary} />
            <Text style={styles.getHelpText}>{t('onboarding.getHelp')}</Text>
        </Pressable>
    );
});

const styles = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    body: {
        flex: 1,
    },
    bodyContent: {
        flexGrow: 1,
        alignItems: 'center',
        paddingVertical: 8,
    },
    spacer: {
        flexGrow: 1,
    },
    block: {
        width: '100%',
        maxWidth: 480,
        paddingHorizontal: 24,
    },
    // Layers share one box: each is the full width, every one after the
    // first pulled back over it, and the row is as tall as the tallest.
    layers: {
        flexDirection: 'row',
    },
    layer: {
        width: '100%',
        flexShrink: 0,
    },
    layerOver: {
        marginLeft: '-100%',
    },
    reserve: {
        opacity: 0,
    },
    primary: {
        marginTop: 12,
    },
    secondary: {
        marginTop: 4,
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        paddingHorizontal: 16,
    },
    getHelp: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 36,
        paddingHorizontal: 12,
        borderRadius: 18,
    },
    getHelpPressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    getHelpText: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        color: theme.colors.textSecondary,
    },
}));
