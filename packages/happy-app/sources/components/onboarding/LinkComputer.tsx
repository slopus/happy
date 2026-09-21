import * as React from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '../RoundButton';
import { TerminalBlock } from './TerminalBlock';
import { OnboardingHeader } from './OnboardingHeader';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { useAllMachines, useLocalSettingMutable } from '@/sync/storage';
import { collectMachineChoices } from '@/sync/machineChoices';
import { Modal } from '@/modal';
import { trackConnectAttempt } from '@/track';
import { t } from '@/text';
import { getServerInfo } from '@/sync/serverConfig';
import { openExternalUrl } from '@/utils/openExternalUrl';

const DESKTOP_URL = 'https://happy.engineering';

/**
 * Where somebody stuck on this screen can turn, and to whom. The same list
 * the desktop app offers during its own setup.
 */
const HELP_LINKS: readonly { label: () => string; url: string }[] = [
    { label: () => t('onboarding.helpDiscord'), url: 'https://discord.gg/fX9WBAhyfD' },
    { label: () => t('onboarding.helpBra1nDump'), url: 'https://x.com/bra1n_dump' },
    { label: () => t('onboarding.helpEx3ndr'), url: 'https://x.com/Ex3NDR' },
    { label: () => t('onboarding.helpIssues'), url: 'https://github.com/slopus/happy/issues' },
];

/**
 * How long to keep saying "connected" after a successful scan while the linked
 * machine syncs in. The screen underneath swaps itself out the moment the
 * machine arrives; this only bounds how long the button stays busy if it never
 * does.
 */
const MACHINE_ARRIVAL_TIMEOUT_MS = 10_000;

/** Room kept under the checklist so the corner button never covers its last row. */
const GET_HELP_RESERVED_HEIGHT = 56;
const SCROLL_BOTTOM_PADDING = 48;

type ChecklistRowProps = {
    checked: boolean;
    title: string;
    /** Tapping the row toggles it. Rows without this are read-only. */
    onToggle?: () => void;
    /** Shown under the title while the row is unchecked. */
    children?: React.ReactNode;
    busy?: boolean;
    dimmed?: boolean;
};

/**
 * One box on the list. A checked row folds its body away so the list gets
 * shorter as the person works down it; the unchecked rows are the ones with
 * something left to read.
 */
const ChecklistRow = React.memo(function ChecklistRow({
    checked,
    title,
    onToggle,
    children,
    busy,
    dimmed,
}: ChecklistRowProps) {
    const { theme } = useUnistyles();
    const box = busy ? (
        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
    ) : (
        <Ionicons
            name={checked ? 'checkmark-circle' : 'ellipse-outline'}
            size={26}
            color={checked ? theme.colors.success : theme.colors.textSecondary}
        />
    );
    return (
        <View style={styles.row}>
            <Pressable
                onPress={onToggle}
                disabled={!onToggle}
                accessibilityRole={onToggle ? 'checkbox' : undefined}
                accessibilityState={onToggle ? { checked } : undefined}
                hitSlop={8}
                style={({ pressed }) => [styles.rowHead, pressed && onToggle && styles.rowHeadPressed]}
            >
                <View style={styles.box}>{box}</View>
                <Text style={[styles.rowTitle, (checked || dimmed) && styles.rowTitleDone]}>{title}</Text>
            </Pressable>
            {!checked && children ? (
                <View style={styles.rowBody}>{children}</View>
            ) : null}
        </View>
    );
});

function useScanActions(onSuccess: () => void) {
    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal({ onSuccess });

    const scan = React.useCallback(() => {
        trackConnectAttempt();
        void connectTerminal();
    }, [connectTerminal]);

    const pasteLink = React.useCallback(async () => {
        const url = await Modal.prompt(
            t('onboarding.pasteLinkTitle'),
            t('onboarding.pasteLinkMessage'),
            {
                placeholder: 'happy://terminal?...',
                cancelText: t('common.cancel'),
                confirmText: t('onboarding.pasteLinkConfirm'),
            },
        );
        if (url?.trim()) {
            trackConnectAttempt();
            void connectWithUrl(url.trim());
        }
    }, [connectWithUrl]);

    return { scan, pasteLink, isLoading };
}

/**
 * The link-your-computer checklist. `link` is the first run: nothing is
 * linked yet, three boxes to tick. `offline` is the same list once a computer
 * is linked but none can be reached: the install box is already ticked and
 * the job is to get Happy running again.
 */
export const LinkComputerChecklist = React.memo(function LinkComputerChecklist({
    variant,
    onShowArchived,
    bottomInset = 0,
}: {
    variant: 'link' | 'offline';
    /** Archive-only accounts keep a way to their archive while offline. */
    onShowArchived?: () => void;
    /** Extra room under the content for anything floating over it. */
    bottomInset?: number;
}) {
    const router = useRouter();
    const machines = useAllMachines({ includeOffline: true });
    const choices = React.useMemo(() => collectMachineChoices(machines), [machines]);
    const [ticked, setTicked] = useLocalSettingMutable('linkComputerChecklist');
    const [approved, setApproved] = React.useState(false);
    const { scan, pasteLink, isLoading } = useScanActions(() => setApproved(true));

    // A scan that never brings a machine in gets its button back after a
    // while, so a person is not stuck on a spinner with nothing to tap.
    React.useEffect(() => {
        if (!approved) return;
        const timer = setTimeout(() => setApproved(false), MACHINE_ARRIVAL_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [approved]);

    const toggle = React.useCallback((key: 'install' | 'open') => {
        setTicked({ ...ticked, [key]: !ticked[key] });
    }, [setTicked, ticked]);

    const busy = isLoading || approved;
    const canScan = Platform.OS !== 'web';

    const openDesktopSite = React.useCallback(() => {
        void Linking.openURL(DESKTOP_URL);
    }, []);

    const downloadLine = (
        <Text style={styles.body}>
            {t('onboarding.installBodyPrefix')}
            <Text style={styles.link} accessibilityRole="link" onPress={openDesktopSite}>
                {t('onboarding.installBodyLink')}
            </Text>
            {t('onboarding.installBodySuffix')}
        </Text>
    );

    const scanActions = (
        <View style={styles.actions}>
            {canScan ? (
                <View style={styles.button}>
                    <RoundButton
                        title={approved ? t('onboarding.connecting') : t('onboarding.scanButton')}
                        loading={busy}
                        onPress={scan}
                    />
                </View>
            ) : null}
            <View style={styles.button}>
                <RoundButton
                    size="normal"
                    display={canScan ? 'inverted' : 'default'}
                    title={t('onboarding.pasteLink')}
                    disabled={busy}
                    onPress={() => { void pasteLink(); }}
                />
            </View>
        </View>
    );

    if (variant === 'offline') {
        const title = choices.length === 1
            ? t('onboarding.offlineTitleOne', { name: choices[0].name })
            : t('onboarding.offlineTitleMany');
        const linked = choices.length === 1
            ? t('onboarding.offlineLinkedStep', { name: choices[0].name })
            : t('onboarding.offlineLinkedStepMany', { count: choices.length });
        return (
            <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: SCROLL_BOTTOM_PADDING + bottomInset }]} keyboardShouldPersistTaps="handled">
                <View style={styles.content}>
                    <Text style={styles.title}>{title}</Text>
                    <ChecklistRow checked title={linked} />
                    <ChecklistRow checked={false} title={t('onboarding.offlineOpenStep')}>
                        <Text style={styles.body}>{t('onboarding.offlineOpenBody')}</Text>
                        <TerminalBlock
                            style={styles.terminal}
                            lines={[{ kind: 'command', text: t('onboarding.terminalRun') }]}
                        />
                    </ChecklistRow>
                    <View style={styles.actions}>
                        <View style={styles.button}>
                            <RoundButton
                                title={t('onboarding.offlineTroubleshoot')}
                                onPress={() => router.push('/troubleshoot')}
                            />
                        </View>
                        {canScan ? (
                            <View style={styles.button}>
                                <RoundButton
                                    size="normal"
                                    display="inverted"
                                    title={approved ? t('onboarding.connecting') : t('onboarding.linkAnother')}
                                    loading={busy}
                                    onPress={scan}
                                />
                            </View>
                        ) : null}
                        {onShowArchived ? (
                            <View style={styles.button}>
                                <RoundButton
                                    size="normal"
                                    display="inverted"
                                    title={t('sidebar.showArchived')}
                                    onPress={onShowArchived}
                                />
                            </View>
                        ) : null}
                    </View>
                </View>
            </ScrollView>
        );
    }

    return (
        <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: SCROLL_BOTTOM_PADDING + bottomInset }]} keyboardShouldPersistTaps="handled">
            <View style={styles.content}>
                <ChecklistRow
                    checked={!!ticked.install}
                    title={t('onboarding.installStep')}
                    onToggle={() => toggle('install')}
                >
                    {downloadLine}
                    <TerminalBlock
                        style={styles.terminal}
                        lines={[
                            { kind: 'comment', text: t('onboarding.terminalComment') },
                            { kind: 'command', text: t('onboarding.terminalInstall') },
                            { kind: 'command', text: t('onboarding.terminalRun') },
                        ]}
                    />
                </ChecklistRow>
                <ChecklistRow
                    checked={!!ticked.open}
                    title={t('onboarding.openStep')}
                    onToggle={() => toggle('open')}
                >
                    <Text style={styles.body}>{t('onboarding.openBody')}</Text>
                </ChecklistRow>
                <ChecklistRow
                    checked={approved}
                    title={t('onboarding.scanStep')}
                    busy={isLoading}
                >
                    {scanActions}
                </ChecklistRow>
                {approved ? (
                    <Text style={[styles.body, styles.connected]}>{t('onboarding.connected')}</Text>
                ) : null}
            </View>
        </ScrollView>
    );
});

/**
 * Somewhere to turn without leaving the step you are stuck on. The options
 * arrive as the app's ordinary alert — a native sheet on a phone, the web
 * modal in a browser — so this adds a corner button, not a new surface.
 */
export const GetHelpButton = React.memo(function GetHelpButton() {
    const { theme } = useUnistyles();

    const openHelp = React.useCallback(() => {
        Modal.alert(
            t('onboarding.getHelp'),
            t('onboarding.helpMessage'),
            [
                ...HELP_LINKS.map((link) => ({
                    text: link.label(),
                    onPress: () => { void openExternalUrl(link.url); },
                })),
                { text: t('common.cancel'), style: 'cancel' as const },
            ],
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

/**
 * The first-run screen: the checklist under its own header, in place of the
 * session list and its dock. Shown at the home route once the account exists
 * and no machine has been linked yet.
 */
export const OnboardingLinkComputer = React.memo(function OnboardingLinkComputer() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const serverInfo = getServerInfo();
    return (
        <View style={styles.root}>
            <OnboardingHeader
                title={t('onboarding.linkTitle')}
                subtitle={serverInfo.isCustom ? serverInfo.hostname + (serverInfo.port ? `:${serverInfo.port}` : '') : undefined}
                headerRight={() => (
                    <Pressable
                        onPress={() => router.push('/onboarding/settings')}
                        hitSlop={15}
                        accessibilityRole="button"
                        accessibilityLabel={t('onboarding.settingsTitle')}
                        style={styles.headerButton}
                    >
                        <Ionicons name="settings-outline" size={22} color={theme.colors.header.tint} />
                    </Pressable>
                )}
            />
            <LinkComputerChecklist variant="link" bottomInset={GET_HELP_RESERVED_HEIGHT} />
            <View style={[styles.getHelpCorner, { bottom: insets.bottom + 12 }]} pointerEvents="box-none">
                <GetHelpButton />
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    headerButton: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    scroll: {
        alignItems: 'center',
        paddingTop: 16,
    },
    // Sits over the checklist rather than under it, so a short list keeps the
    // button at the bottom of the screen instead of floating mid-page.
    getHelpCorner: {
        position: 'absolute',
        right: 16,
        alignItems: 'flex-end',
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
    content: {
        width: '100%',
        maxWidth: 480,
        paddingHorizontal: 24,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 24,
        lineHeight: 30,
        color: theme.colors.text,
        marginBottom: 16,
        paddingHorizontal: 4,
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
    rowHeadPressed: {
        opacity: 0.6,
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
    rowTitleDone: {
        color: theme.colors.textSecondary,
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
    terminal: {
        marginTop: 12,
    },
    actions: {
        alignItems: 'flex-start',
        marginTop: 6,
    },
    button: {
        width: 260,
        maxWidth: '100%',
        marginBottom: 8,
    },
    connected: {
        paddingLeft: 38,
        color: theme.colors.success,
    },
}));
