import * as React from 'react';
import { View, Text, Pressable, Platform, Image as RNImage, LayoutAnimation } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { Session } from '@/sync/storageTypes';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { storage, useSetting } from '@/sync/storage';
import { t } from '@/text';
import { Modal } from '@/modal';
import * as Clipboard from 'expo-clipboard';
import { getRunningSessionInfoExperience } from '@/utils/newSessionExperience';
import { resolveRunningSessionTurnModes } from '@/utils/runningSessionTurnModes';
import {
    canKeepSessionInfoExpansion,
    type SessionInfoExpandedRow,
} from '@/utils/sessionInfoDropdownState';
import { useSessionTaskPermission } from '@/hooks/useSessionTaskPermission';
import type { TaskPermissionLevel } from '@/utils/taskPermissionModes';

// Agent icon assets — mirrors SessionConfigPanel so the panel reads identically.
const agentIcons = {
    ask: require('@/assets/images/icon-claude.png'),
    claude: require('@/assets/images/icon-claude.png'),
    codex: require('@/assets/images/icon-gpt.png'),
    opencode: require('@/assets/images/icon-gpt.png'),
    openclaw: require('@/assets/images/icon-openclaw.png'),
    gemini: require('@/assets/images/icon-gemini.png'),
} as const;

const AGENT_LABELS: Record<string, string> = {
    ask: 'ask',
    claude: 'claude code',
    codex: 'codex',
    opencode: 'opencode',
    openclaw: 'openclaw',
    gemini: 'gemini',
};

type AgentKey = keyof typeof agentIcons;

// Permission glyph, matching SessionConfigPanel's getPermissionStyle.
function permissionIcon(level: TaskPermissionLevel | null): 'warning-outline' | 'shield-checkmark-outline' {
    return level === 'full-access' ? 'warning-outline' : 'shield-checkmark-outline';
}

/**
 * Session config panel that drops down under the chat header when the
 * SessionHeaderChip is tapped. Visually mirrors the particle home's inline
 * SessionConfigPanel (machine / folder / agent·model·effort / permission) and
 * reflects the *running* session's metadata.
 *
 * Editability splits by what the running CLI process can actually change mid-
 * session: model / effort are per-turn meta (happy-cli re-reads them from each
 * outgoing message), so those rows are tappable and expand an inline option
 * list — the pick takes effect on the *next* turn. Permission mode also
 * persists onto future turns, and Codex can hot-apply it to the current turn
 * through a session RPC. machine / folder / agent are baked into the spawned
 * process and can't change without a new session, so they stay read-only. Each
 * editable row only becomes tappable when it actually has more than one option
 * to choose from.
 *
 * A "Session details" row at the bottom links into the full info screen.
 * Renders its own full-screen backdrop so a tap anywhere outside collapses it.
 */
interface SessionInfoDropdownProps {
    session: Session;
    machineName: string | null;
    online: boolean;
    /** Y offset where the panel/backdrop begin (header bottom = safeArea.top + headerHeight). */
    top: number;
    canCopySessionId?: boolean;
    onClose: () => void;
    onViewDetails: () => void;
}

export const SessionInfoDropdown = React.memo(({ session, machineName, online, top, canCopySessionId = false, onClose, onViewDetails }: SessionInfoDropdownProps) => {
    const { theme } = useUnistyles();
    const metadata = session.metadata;
    const flavor = metadata?.flavor ?? undefined;
    const agentKey: AgentKey = (flavor && flavor in agentIcons ? flavor : 'claude') as AgentKey;
    const agentLabel = AGENT_LABELS[agentKey] ?? agentKey;
    const pathName = metadata?.path ? formatPathRelativeToHome(metadata.path, metadata.homeDir) : null;
    const infoExperience = React.useMemo(
        () => getRunningSessionInfoExperience(flavor),
        [flavor],
    );

    // Resolve the session's current model / permission / effort display names the
    // same way SessionViewLoaded does, so the panel matches the chat's selectors.
    const agentDefaultOverrides = useSetting('agentDefaultOverrides');
    const taskPermission = useSessionTaskPermission(session, online);
    const permissionOptions = [
        { key: 'confirm', name: t('agentInput.taskPermission.confirm') },
        { key: 'full-access', name: t('agentInput.taskPermission.fullAccess') },
    ];
    const permissionLabel = taskPermission.level === 'full-access'
        ? t('agentInput.taskPermission.fullAccess')
        : taskPermission.supported
            ? t('agentInput.taskPermission.confirm')
            : t('agentInput.taskPermission.unavailable');

    const turnModes = React.useMemo(() => resolveRunningSessionTurnModes({
        session,
        agentDefaultOverrides,
        translate: t,
    }), [agentDefaultOverrides, session]);
    const {
        availableModels,
        modelMode,
        availableEffortLevels,
        effortLevel,
    } = turnModes;

    // Only the rows with a real choice (>1 option) become tappable; otherwise
    // there's nothing to switch to and they stay read-only.
    const canEditPermission = online && taskPermission.supported;
    const canEditModel = online && availableModels.length > 1;
    const canEditEffort = online && availableEffortLevels.length > 1;

    // Which editable row is currently expanded into its option list (one at a time).
    // Animate every expand/collapse so the option list slides in/out smoothly.
    const [expanded, setExpanded] = React.useState<SessionInfoExpandedRow>(null);
    const canKeepExpansion = canKeepSessionInfoExpansion(expanded, {
        permission: canEditPermission,
        model: canEditModel,
        effort: canEditEffort,
    });
    const visibleExpanded = canKeepExpansion ? expanded : null;

    React.useEffect(() => {
        if (!canKeepExpansion) {
            setExpanded(null);
        }
    }, [canKeepExpansion]);
    const animateNext = React.useCallback(() => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    }, []);
    const toggle = React.useCallback((row: 'permission' | 'model' | 'effort') => {
        animateNext();
        setExpanded((cur) => (cur === row ? null : row));
    }, [animateNext]);

    // Apply a pick to the running session. The value is always persisted for
    // future turns via message meta; Codex also receives an immediate RPC update
    // so a turn already blocked on permissions can continue.
    const applyPermission = React.useCallback(async (key: string) => {
        const applied = await taskPermission.onLevelChange(key as TaskPermissionLevel);
        if (applied) {
            animateNext();
            setExpanded(null);
        }
    }, [animateNext, taskPermission.onLevelChange]);
    const applyModel = React.useCallback((key: string) => {
        if (!online) return;
        storage.getState().updateSessionModelMode(session.id, key);
        animateNext();
        setExpanded(null);
    }, [session.id, animateNext, online]);
    const applyEffort = React.useCallback((key: string) => {
        if (!online) return;
        storage.getState().updateSessionEffortLevel(session.id, key);
        animateNext();
        setExpanded(null);
    }, [session.id, animateNext, online]);
    const copySessionId = React.useCallback(async () => {
        await Clipboard.setStringAsync(`Happy sessionId: ${session.id}`);
        onClose();
        Modal.alert(t('common.copied'), 'Session ID copied to clipboard');
    }, [session.id, onClose]);

    // Inline option list shown under an expanded editable row.
    const renderOptions = (
        options: { key: string; name: string }[],
        currentKey: string | undefined,
        onSelect: (key: string) => void | Promise<void>,
    ) => (
        <View style={styles.optionList}>
            {options.map((opt) => {
                const isSelected = opt.key === currentKey;
                return (
                    <Pressable
                        key={opt.key}
                        style={(p) => [styles.optionRow, p.pressed && styles.rowPressed]}
                        onPress={() => void onSelect(opt.key)}
                    >
                        <Ionicons
                            name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
                            size={15}
                            color={isSelected ? theme.colors.text : theme.colors.textSecondary}
                        />
                        <Text
                            style={[styles.configLabel, styles.configValueText, !isSelected && { color: theme.colors.textSecondary }]}
                            numberOfLines={1}
                        >
                            {opt.name}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );

    return (
        <>
            <Pressable style={[styles.backdrop, { top }]} onPress={onClose} />
            <View style={[styles.dropdown, { top }]}>
                <View style={styles.configBox}>
                    {/* Machine */}
                    <View style={styles.configRow}>
                        <Ionicons name="desktop-outline" size={15} color={theme.colors.textSecondary} />
                        <Text style={[styles.configLabel, styles.configValueText]} numberOfLines={1}>
                            {machineName ?? t('agentInput.noMachinesAvailable')}
                        </Text>
                        <View style={[styles.dot, { backgroundColor: online ? theme.colors.status.connected : theme.colors.status.disconnected }]} />
                    </View>

                    {/* Folder */}
                    {infoExperience.showPath && pathName ? (
                        <View style={styles.configRow}>
                            <Ionicons name="folder-outline" size={15} color={theme.colors.textSecondary} />
                            <Text style={[styles.configLabel, styles.configValueText]} numberOfLines={1}>
                                {pathName}
                            </Text>
                        </View>
                    ) : null}

                    {/* Agent (read-only) · Model · Effort. Model/effort tap to expand. */}
                    <View style={styles.configRow}>
                        <View style={styles.configInlineField}>
                            <RNImage
                                source={agentIcons[agentKey]}
                                style={[styles.agentIcon, { tintColor: theme.colors.textSecondary }]}
                                resizeMode="contain"
                            />
                            <Text style={[styles.configLabel, styles.configInlineText]} numberOfLines={1}>
                                {agentLabel}
                            </Text>
                        </View>
                        {infoExperience.showModelDetails && modelMode?.name ? (
                            <>
                                <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]}>·</Text>
                                {canEditModel ? (
                                    <Pressable
                                        onPress={() => toggle('model')}
                                        style={(p) => [styles.configInlineField, p.pressed && styles.rowPressed]}
                                    >
                                        <Text style={[styles.configLabel, styles.configInlineText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                                            {modelMode.name}
                                        </Text>
                                        <Ionicons name={visibleExpanded === 'model' ? 'chevron-up' : 'chevron-down'} size={11} color={theme.colors.textSecondary} />
                                    </Pressable>
                                ) : (
                                    <Text style={[styles.configLabel, styles.configInlineText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                                        {modelMode.name}
                                    </Text>
                                )}
                            </>
                        ) : null}
                        {infoExperience.showModelDetails && effortLevel?.name ? (
                            <>
                                <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]}>·</Text>
                                {canEditEffort ? (
                                    <Pressable
                                        onPress={() => toggle('effort')}
                                        style={(p) => [styles.configInlineField, p.pressed && styles.rowPressed]}
                                    >
                                        <Text style={[styles.configLabel, styles.configInlineText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                                            {effortLevel.name}
                                        </Text>
                                        <Ionicons name={visibleExpanded === 'effort' ? 'chevron-up' : 'chevron-down'} size={11} color={theme.colors.textSecondary} />
                                    </Pressable>
                                ) : (
                                    <Text style={[styles.configLabel, styles.configInlineText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                                        {effortLevel.name}
                                    </Text>
                                )}
                            </>
                        ) : null}
                    </View>
                    {infoExperience.showModelDetails && visibleExpanded === 'model' ? renderOptions(availableModels, modelMode?.key, applyModel) : null}
                    {infoExperience.showModelDetails && visibleExpanded === 'effort' ? renderOptions(availableEffortLevels, effortLevel?.key, applyEffort) : null}

                    {/* Permission mode — tap to expand when there's more than one. */}
                    {infoExperience.showPermission ? (
                        canEditPermission ? (
                            <Pressable
                                style={(p) => [styles.configRow, p.pressed && styles.rowPressed]}
                                onPress={() => toggle('permission')}
                            >
                                <Ionicons name={permissionIcon(taskPermission.level)} size={15} color={theme.colors.textSecondary} />
                                <Text style={[styles.configLabel, styles.configValueText]} numberOfLines={1}>
                                    {permissionLabel}
                                </Text>
                                <Ionicons name={visibleExpanded === 'permission' ? 'chevron-up' : 'chevron-down'} size={13} color={theme.colors.textSecondary} />
                            </Pressable>
                        ) : (
                            <View style={styles.configRow}>
                                <Ionicons name={permissionIcon(taskPermission.level)} size={15} color={theme.colors.textSecondary} />
                                <Text style={[styles.configLabel, styles.configValueText]} numberOfLines={1}>
                                    {taskPermission.unavailableReason ?? permissionLabel}
                                </Text>
                            </View>
                        )
                    ) : null}
                    {infoExperience.showPermission && visibleExpanded === 'permission'
                        ? renderOptions(permissionOptions, taskPermission.level ?? 'confirm', applyPermission)
                        : null}

                    {/* Divider + entry into the full info screen (the one tappable row). */}
                    <View style={styles.divider} />
                    {canCopySessionId ? (
                        <Pressable
                            style={(p) => [styles.configRow, p.pressed && styles.rowPressed]}
                            onPress={copySessionId}
                        >
                            <Ionicons name="copy-outline" size={15} color={theme.colors.text} />
                            <Text style={[styles.configLabel, styles.configValueText]} numberOfLines={1}>
                                Copy Session ID
                            </Text>
                        </Pressable>
                    ) : null}
                    <Pressable
                        style={(p) => [styles.configRow, p.pressed && styles.rowPressed]}
                        onPress={onViewDetails}
                    >
                        <Ionicons name="information-circle-outline" size={15} color={theme.colors.text} />
                        <Text style={[styles.configLabel, styles.configValueText]} numberOfLines={1}>
                            {t('sessionInfo.viewDetails')}
                        </Text>
                        <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                    </Pressable>
                </View>
            </View>
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    backdrop: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 10,
    },
    dropdown: {
        position: 'absolute',
        left: 0,
        right: 0,
        paddingHorizontal: 12,
        paddingTop: 8,
        zIndex: 11,
    },
    configBox: {
        backgroundColor: theme.colors.input.background,
        borderRadius: Platform.select({ default: 16, android: 20 }),
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        paddingVertical: 4,
        paddingHorizontal: 4,
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 12,
        elevation: 8,
    },
    configRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
    },
    rowPressed: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    configLabel: {
        minWidth: 0,
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    },
    configValueText: {
        flex: 1,
        flexShrink: 1,
    },
    configInlineField: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        minWidth: 0,
        flexShrink: 1,
    },
    configInlineText: {
        minWidth: 0,
        flexShrink: 1,
    },
    agentIcon: {
        width: 15,
        height: 15,
    },
    dot: {
        width: 7,
        height: 7,
        borderRadius: 3.5,
    },
    divider: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
        marginHorizontal: 12,
        marginVertical: 2,
    },
    optionList: {
        marginHorizontal: 8,
        marginBottom: 4,
        paddingVertical: 2,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHigh,
    },
    optionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
        paddingHorizontal: 12,
        paddingVertical: 9,
        borderRadius: 10,
    },
}));
