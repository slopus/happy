import * as React from 'react';
import { AccessibilityInfo, BackHandler, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '../RoundButton';
import { TerminalBlock } from './TerminalBlock';
import { OnboardingHeader } from './OnboardingHeader';
import { OnboardingScreen } from './OnboardingScreen';
import { ChecklistRow, LinkComputerContent, type LinkChecklistStep } from './OnboardingContent';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { useAllMachines, useLocalSettingMutable } from '@/sync/storage';
import { collectMachineChoices } from '@/sync/machineChoices';
import { Modal } from '@/modal';
import { trackConnectAttempt } from '@/track';
import { t } from '@/text';
import { getServerInfo } from '@/sync/serverConfig';

/**
 * How long to keep the button busy after a successful scan while the linked
 * machine syncs in. The screen underneath swaps itself out the moment the
 * machine arrives; this only bounds how long the button stays busy if it never
 * does.
 */
const MACHINE_ARRIVAL_TIMEOUT_MS = 10_000;

function useScanActions(options: { onSuccess: () => void; onError?: () => void }) {
    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal(options);

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
 * A scan that went through, kept busy until the linked machine syncs in and
 * the screen is replaced. One that never brings a machine in gets its button
 * back after a while, so a person is not stuck on a spinner with nothing to tap.
 */
function useApproved() {
    const [approved, setApproved] = React.useState(false);
    React.useEffect(() => {
        if (!approved) return;
        const timer = setTimeout(() => setApproved(false), MACHINE_ARRIVAL_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [approved]);
    return [approved, setApproved] as const;
}

/**
 * The checklist once a computer is linked but none can be reached: the
 * install box is already ticked and the job is to get Happy running again.
 */
export const LinkComputerChecklist = React.memo(function LinkComputerChecklist({
    onShowArchived,
}: {
    /** Archive-only accounts keep a way to their archive while offline. */
    onShowArchived?: () => void;
}) {
    const router = useRouter();
    const machines = useAllMachines({ includeOffline: true });
    const choices = React.useMemo(() => collectMachineChoices(machines), [machines]);
    const [approved, setApproved] = useApproved();
    const scanOptions = React.useMemo(() => ({ onSuccess: () => setApproved(true) }), [setApproved]);
    const { scan, isLoading } = useScanActions(scanOptions);

    const busy = isLoading || approved;
    const canScan = Platform.OS !== 'web';

    const title = choices.length === 1
        ? t('onboarding.offlineTitleOne', { name: choices[0].name })
        : t('onboarding.offlineTitleMany');
    const linked = choices.length === 1
        ? t('onboarding.offlineLinkedStep', { name: choices[0].name })
        : t('onboarding.offlineLinkedStepMany', { count: choices.length });
    return (
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
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
                                title={approved ? t('onboarding.linking') : t('onboarding.linkAnother')}
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
});

/**
 * The first-run screen, in place of the session list and its dock. Shown at
 * the home route once the account exists and no machine has been linked yet.
 * Scanning opens once both boxes are ticked. A link in flight keeps the button
 * busy until the linked machine arrives and the session list replaces this
 * screen; a failed one says so on the line above the button. There is no way
 * back from here: the account exists, and the only way on is a linked computer.
 */
export const OnboardingLinkComputer = React.memo(function OnboardingLinkComputer() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const serverInfo = getServerInfo();
    const [ticked, setTicked] = useLocalSettingMutable('linkComputerChecklist');
    const [approved, setApproved] = useApproved();
    const [error, setError] = React.useState<string | null>(null);
    const scanOptions = React.useMemo(() => ({
        onSuccess: () => setApproved(true),
        onError: () => setError(t('onboarding.linkFailed')),
    }), [setApproved]);
    const { scan, pasteLink, isLoading } = useScanActions(scanOptions);

    const busy = isLoading || approved;
    const ready = !!ticked.install && !!ticked.open;

    // Android's back button would leave the app from here; swipe-back is off
    // in the layout. Only while focused, so the gear's settings still close.
    useFocusEffect(React.useCallback(() => {
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
        return () => subscription.remove();
    }, []));

    React.useEffect(() => {
        if (error) AccessibilityInfo.announceForAccessibility(error);
    }, [error]);

    const toggle = React.useCallback((step: LinkChecklistStep) => {
        setTicked({ ...ticked, [step]: !ticked[step] });
    }, [setTicked, ticked]);

    const startScan = React.useCallback(() => {
        setError(null);
        scan();
    }, [scan]);

    const startPaste = React.useCallback(() => {
        setError(null);
        void pasteLink();
    }, [pasteLink]);

    return (
        <OnboardingScreen
            header={
                <OnboardingHeader
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
            }
            content={
                <LinkComputerContent
                    ticked={ticked}
                    onToggle={toggle}
                    disabled={busy}
                    error={error}
                />
            }
            primary={
                <RoundButton
                    title={t('onboarding.scanButton')}
                    loadingTitle={t('onboarding.linking')}
                    loading={busy}
                    disabled={busy || !ready}
                    onPress={startScan}
                />
            }
            secondary={{
                title: t('onboarding.pasteLink'),
                onPress: startPaste,
                disabled: busy,
            }}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    headerButton: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    scroll: {
        alignItems: 'center',
        paddingTop: 16,
        paddingBottom: 48,
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
    body: {
        ...Typography.default(),
        fontSize: 15,
        lineHeight: 21,
        color: theme.colors.textSecondary,
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
}));
