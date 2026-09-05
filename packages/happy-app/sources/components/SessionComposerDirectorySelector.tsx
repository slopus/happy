import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import {
    ActivityIndicator,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    Text,
    TextInput,
    View,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { machineBrowseDirectory, type BrowseDirectoryEntry } from '@/sync/ops';
import { formatWorkingDirectoryLabel } from '@/utils/sessionWorkingDirectory';

export type SessionComposerDirectorySelectorConfig = {
    currentPath: string;
    currentPathLabel: string;
    homeDir?: string;
    machineId: string;
    machineOnline: boolean;
    recentPaths: string[];
    switching: boolean;
    onSwitch: (path: string) => Promise<{ success: true } | { success: false; error: string }>;
};

type Props = SessionComposerDirectorySelectorConfig & {
    onInvalidStateChange: (invalid: boolean) => void;
};

export const SessionComposerDirectorySelector = React.memo(function SessionComposerDirectorySelector(props: Props) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const [hovered, setHovered] = React.useState(false);
    const [candidate, setCandidate] = React.useState(props.currentPath);
    const [error, setError] = React.useState<string | null>(null);
    const [browsing, setBrowsing] = React.useState(false);
    const [browseLoading, setBrowseLoading] = React.useState(false);
    const [browsePath, setBrowsePath] = React.useState<string | null>(null);
    const [browseParent, setBrowseParent] = React.useState<string | null>(null);
    const [browseDirectories, setBrowseDirectories] = React.useState<BrowseDirectoryEntry[]>([]);

    const resetPicker = React.useCallback(() => {
        setCandidate(props.currentPath);
        setError(null);
        setBrowsing(false);
        props.onInvalidStateChange(false);
    }, [props.currentPath, props.onInvalidStateChange]);

    React.useEffect(() => {
        resetPicker();
    }, [resetPicker]);

    const close = React.useCallback(() => {
        setOpen(false);
        resetPicker();
    }, [resetPicker]);

    const openPicker = React.useCallback(() => {
        resetPicker();
        setOpen(true);
    }, [resetPicker]);

    const updateCandidate = React.useCallback((path: string) => {
        setCandidate(path);
        setError(null);
        props.onInvalidStateChange(path.trim() !== props.currentPath);
    }, [props.currentPath, props.onInvalidStateChange]);

    const describeError = React.useCallback((reason: string) => {
        switch (reason) {
            case 'machine-offline':
                return t('components.messageComposer.workingDirectoryOffline');
            case 'session-busy':
                return t('components.messageComposer.workingDirectoryBusy');
            case 'unsupported-agent':
                return t('components.messageComposer.workingDirectoryUnsupported');
            case 'continuation-unavailable':
                return t('components.messageComposer.workingDirectoryContinuationUnavailable');
            case 'session-hydration-failed':
                return t('newSession.sessionHydrationFailed');
            default:
                return t('components.messageComposer.workingDirectoryError', { reason });
        }
    }, []);

    const applyPath = React.useCallback(async (path: string) => {
        const trimmed = path.trim();
        if (!trimmed) {
            const message = t('components.messageComposer.workingDirectoryError', {
                reason: t('components.messageComposer.workingDirectoryEmpty'),
            });
            setError(message);
            props.onInvalidStateChange(true);
            return;
        }

        setError(null);
        props.onInvalidStateChange(true);
        const result = await props.onSwitch(trimmed);
        if (!result.success) {
            setError(describeError(result.error));
            props.onInvalidStateChange(true);
            return;
        }
        close();
    }, [close, describeError, props.onInvalidStateChange, props.onSwitch]);

    const loadDirectory = React.useCallback(async (path: string) => {
        setBrowseLoading(true);
        setError(null);
        const result = await machineBrowseDirectory(props.machineId, path);
        setBrowseLoading(false);
        if (!result.success || !result.path) {
            setError(describeError(result.error ?? 'invalid-directory'));
            props.onInvalidStateChange(true);
            return;
        }
        setBrowsePath(result.path);
        setBrowseParent(result.parent ?? null);
        setBrowseDirectories(result.directories ?? []);
    }, [describeError, props.machineId, props.onInvalidStateChange]);

    const startBrowsing = React.useCallback(() => {
        setBrowsing(true);
        void loadDirectory(candidate.trim() || props.currentPath);
    }, [candidate, loadDirectory, props.currentPath]);

    const busy = props.switching || browseLoading;
    // Keep the current path inspectable even while the Agent is offline.
    // Only an in-flight switch disables the disclosure itself; browse/apply
    // remain guarded separately and surface the reconnect guidance.
    const chipDisabled = props.switching;

    return (
        <View style={styles.anchor}>
            <Pressable
                testID="session-working-directory-trigger"
                accessibilityRole="button"
                accessibilityLabel={`${t('components.messageComposer.workingDirectory')}: ${props.currentPath}`}
                accessibilityHint={t('components.messageComposer.workingDirectoryFutureHint')}
                disabled={chipDisabled}
                onPress={openPicker}
                onHoverIn={() => setHovered(true)}
                onHoverOut={() => setHovered(false)}
                style={({ pressed }) => [
                    styles.chip,
                    props.switching && styles.chipDisabled,
                    pressed && styles.pressed,
                ]}
            >
                {props.switching ? (
                    <ActivityIndicator size="small" color={theme.colors.button.secondary.tint} />
                ) : (
                    <Ionicons name="folder-outline" size={15} color={theme.colors.button.secondary.tint} />
                )}
                <Text style={styles.chipText} numberOfLines={1}>{props.currentPathLabel}</Text>
                <Ionicons name="chevron-down" size={12} color={theme.colors.textSecondary} />
            </Pressable>

            {hovered && !open && Platform.OS === 'web' ? (
                <View style={styles.tooltip} pointerEvents="none" testID="session-working-directory-tooltip">
                    <Text style={styles.tooltipText}>{props.currentPath}</Text>
                </View>
            ) : null}

            <Modal
                visible={open}
                transparent
                animationType="fade"
                onRequestClose={close}
            >
                <View style={styles.modalRoot}>
                    <Pressable style={styles.backdrop} onPress={close} />
                    <View style={styles.panel} testID="session-working-directory-dialog">
                        <View style={styles.header}>
                            <View style={styles.headerCopy}>
                                <Text style={styles.title}>{t('components.messageComposer.workingDirectory')}</Text>
                                <Text style={styles.hint}>{t('components.messageComposer.workingDirectoryFutureHint')}</Text>
                            </View>
                            <Pressable accessibilityLabel={t('common.cancel')} onPress={close} style={styles.iconButton}>
                                <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                            </Pressable>
                        </View>

                        {browsing ? (
                            <>
                                <View style={styles.browserHeader}>
                                    <Pressable
                                        accessibilityLabel={t('common.back')}
                                        disabled={!browseParent || busy}
                                        onPress={() => browseParent && void loadDirectory(browseParent)}
                                        style={[styles.iconButton, !browseParent && styles.chipDisabled]}
                                    >
                                        <Ionicons name="arrow-back" size={18} color={theme.colors.textSecondary} />
                                    </Pressable>
                                    <Text style={styles.browserPath} numberOfLines={1}>{browsePath}</Text>
                                </View>
                                <ScrollView style={styles.directoryList} contentContainerStyle={styles.directoryListContent}>
                                    {browseDirectories.map((directory) => (
                                        <Pressable
                                            key={directory.path}
                                            testID={`session-working-directory-browse-${directory.name}`}
                                            onPress={() => void loadDirectory(directory.path)}
                                            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                                        >
                                            <Ionicons name="folder-outline" size={17} color={theme.colors.textSecondary} />
                                            <Text style={styles.rowText} numberOfLines={1}>{directory.name}</Text>
                                            <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                                        </Pressable>
                                    ))}
                                </ScrollView>
                                <Pressable
                                    testID="session-working-directory-use-current"
                                    disabled={!browsePath || busy}
                                    onPress={() => browsePath && void applyPath(browsePath)}
                                    style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, busy && styles.chipDisabled]}
                                >
                                    {busy ? <ActivityIndicator size="small" color={theme.colors.button.primary.tint} /> : null}
                                    <Text style={styles.primaryButtonText} numberOfLines={1}>
                                        {t('components.messageComposer.workingDirectorySelectCurrent', {
                                            name: browsePath ? formatWorkingDirectoryLabel(browsePath, props.homeDir) : '',
                                        })}
                                    </Text>
                                </Pressable>
                            </>
                        ) : (
                            <>
                                <View style={styles.inputRow}>
                                    <Ionicons name="folder-outline" size={17} color={theme.colors.textSecondary} />
                                    <TextInput
                                        testID="session-working-directory-input"
                                        accessibilityLabel={t('components.messageComposer.workingDirectory')}
                                        value={candidate}
                                        onChangeText={updateCandidate}
                                        onSubmitEditing={() => void applyPath(candidate)}
                                        placeholder={t('components.messageComposer.workingDirectoryInputPlaceholder')}
                                        placeholderTextColor={theme.colors.textSecondary}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        style={styles.input}
                                    />
                                </View>
                                <View style={styles.buttonRow}>
                                    <Pressable
                                        testID="session-working-directory-browse"
                                        disabled={!props.machineOnline || busy}
                                        onPress={startBrowsing}
                                        style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                                    >
                                        <Ionicons name="folder-open-outline" size={16} color={theme.colors.button.secondary.tint} />
                                        <Text style={styles.secondaryButtonText}>{t('components.messageComposer.workingDirectoryBrowse')}</Text>
                                    </Pressable>
                                    <Pressable
                                        testID="session-working-directory-continue"
                                        disabled={busy}
                                        onPress={() => void applyPath(candidate)}
                                        style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, busy && styles.chipDisabled]}
                                    >
                                        {props.switching ? <ActivityIndicator size="small" color={theme.colors.button.primary.tint} /> : null}
                                        <Text style={styles.primaryButtonText}>{t('common.continue')}</Text>
                                    </Pressable>
                                </View>

                                <Text style={styles.sectionLabel}>{t('components.messageComposer.workingDirectoryRecent')}</Text>
                                <ScrollView style={styles.recentList} contentContainerStyle={styles.directoryListContent}>
                                    {props.recentPaths.map((path) => (
                                        <Pressable
                                            key={path}
                                            testID={`session-working-directory-recent-${formatWorkingDirectoryLabel(path, props.homeDir)}`}
                                            onPress={() => void applyPath(path)}
                                            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                                        >
                                            <Ionicons name="time-outline" size={17} color={theme.colors.textSecondary} />
                                            <View style={styles.rowCopy}>
                                                <Text style={styles.rowText} numberOfLines={1}>{formatWorkingDirectoryLabel(path, props.homeDir)}</Text>
                                                <Text style={styles.rowSubtitle} numberOfLines={1}>{path}</Text>
                                            </View>
                                        </Pressable>
                                    ))}
                                    {props.recentPaths.length === 0 ? (
                                        <Text style={styles.emptyText}>{t('components.messageComposer.workingDirectoryNoRecent')}</Text>
                                    ) : null}
                                </ScrollView>
                            </>
                        )}

                        {error ? (
                            <View style={styles.errorBox} testID="session-working-directory-error">
                                <Ionicons name="alert-circle-outline" size={17} color={theme.colors.textDestructive} />
                                <Text style={styles.errorText}>{error}</Text>
                            </View>
                        ) : null}
                    </View>
                </View>
            </Modal>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    anchor: { position: 'relative', flexShrink: 1 },
    chip: {
        height: 32,
        maxWidth: 190,
        paddingHorizontal: 10,
        borderRadius: 16,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: theme.colors.surfaceHigh,
    },
    chipDisabled: { opacity: 0.55 },
    chipText: { flexShrink: 1, color: theme.colors.button.secondary.tint, fontSize: 13, fontWeight: '600' },
    pressed: { opacity: 0.72 },
    tooltip: {
        position: 'absolute',
        bottom: 38,
        left: 0,
        maxWidth: 420,
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        zIndex: 20,
    },
    tooltipText: { color: theme.colors.text, fontSize: 12 },
    modalRoot: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.42)' },
    panel: {
        width: '100%',
        maxWidth: 520,
        maxHeight: 620,
        gap: 14,
        padding: 18,
        borderRadius: 18,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 24,
        elevation: 12,
    },
    header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
    headerCopy: { flex: 1, gap: 4 },
    title: { color: theme.colors.text, fontSize: 18, fontWeight: '700' },
    hint: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18 },
    iconButton: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
    inputRow: {
        height: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.input.background,
    },
    input: { flex: 1, color: theme.colors.text, fontSize: 14, outlineStyle: 'none' as any },
    buttonRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
    secondaryButton: { height: 40, paddingHorizontal: 14, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: theme.colors.surfaceHigh },
    secondaryButtonText: { color: theme.colors.button.secondary.tint, fontSize: 14, fontWeight: '600' },
    primaryButton: { minHeight: 40, paddingHorizontal: 16, borderRadius: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: theme.colors.button.primary.background },
    primaryButtonText: { color: theme.colors.button.primary.tint, fontSize: 14, fontWeight: '700' },
    sectionLabel: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
    recentList: { maxHeight: 220 },
    directoryList: { maxHeight: 320 },
    directoryListContent: { gap: 3 },
    row: { minHeight: 44, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 9 },
    rowCopy: { flex: 1, minWidth: 0, gap: 2 },
    rowText: { flex: 1, color: theme.colors.text, fontSize: 14, fontWeight: '600' },
    rowSubtitle: { color: theme.colors.textSecondary, fontSize: 11 },
    emptyText: { color: theme.colors.textSecondary, fontSize: 13, paddingVertical: 12, textAlign: 'center' },
    browserHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    browserPath: { flex: 1, color: theme.colors.text, fontSize: 13, fontWeight: '600' },
    errorBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderRadius: 10, padding: 10, backgroundColor: theme.colors.surfaceHigh },
    errorText: { flex: 1, color: theme.colors.textDestructive, fontSize: 13, lineHeight: 18 },
}));
