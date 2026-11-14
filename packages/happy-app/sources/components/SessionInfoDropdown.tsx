import * as React from 'react';
import { View, Text, Pressable, Platform, LayoutAnimation } from 'react-native';
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

// Permission glyph, matching SessionConfigPanel's getPermissionStyle.
function permissionIcon(level: TaskPermissionLevel | null): 'warning-outline' | 'shield-checkmark-outline' {
    return level === 'full-access' ? 'warning-outline' : 'shield-checkmark-outline';
}

export function resolveSessionInfoAgentLabel(
    flavor: string | null | undefined,
    translate: (key: any) => string,
): string {
    switch (flavor) {
        case 'ask':
            return 'ask';
        case 'codex':
            return translate('agentInput.agent.codex');
        case 'gemini':
            return translate('agentInput.agent.gemini');
        case 'opencode':
            return translate('agentInput.agent.opencode');
        case 'openclaw':
            return translate('agentInput.agent.openclaw');
        case 'claude':
        case null:
        case undefined:
            return translate('agentInput.agent.claude');
        default:
            // Third-party ACP flavors must keep their reported identity rather
            // than being mislabeled as one of the built-in agents.
            return flavor;
    }
}

/**
 * Session config panel that drops down under the chat header when the
 * SessionHeaderChip is tapped. It groups the running session's metadata by
 * responsibility: runtime location, next-turn execution, and management.
 *
 * Editability splits by what the running CLI process can actually change mid-
 * session: model / effort are per-turn meta (happy-cli re-reads them from each
 * outgoing message), so those rows are tappable and expand an inline option
 * list — the pick takes effect on the *next* turn. Permission mode also
 * persists onto future turns, and Codex can hot-apply it to the current turn
 * through a session RPC. Machine / address / folder are baked into the spawned
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
    onShareSession?: () => void;
    onViewDetails: () => void;
}

export const SessionInfoDropdown = React.memo(({ session, machineName, online, top, canCopySessionId = false, onClose, onShareSession, onViewDetails }: SessionInfoDropdownProps) => {
    const { theme } = useUnistyles();
    const metadata = session.metadata;
    const flavor = metadata?.flavor ?? undefined;
    const agentLabel = resolveSessionInfoAgentLabel(flavor, t);
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
    const permissionValue = taskPermission.supported
        ? permissionLabel
        : taskPermission.unavailableReason ?? permissionLabel;

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
        Modal.alert(t('common.copied'), t('sessionInfo.happySessionIdCopied'));
    }, [session.id, onClose]);

    const renderRowText = (label: string, value: string) => (
        <View style={styles.rowText}>
            <Text style={styles.rowLabel} numberOfLines={1}>{label}</Text>
            <Text style={styles.rowValue} numberOfLines={2}>{value}</Text>
        </View>
    );

    const renderReadOnlyRow = (args: {
        icon: React.ComponentProps<typeof Ionicons>['name'];
        label: string;
        testID: string;
        value: string;
    }) => (
        <View
            accessibilityLabel={`${args.label}: ${args.value}. ${t('sessionInfo.agentPanelReadOnly')}`}
            style={styles.configRow}
            testID={args.testID}
        >
            <Ionicons name={args.icon} size={16} color={theme.colors.textSecondary} />
            {renderRowText(args.label, args.value)}
            <Text style={styles.rowState}>{t('sessionInfo.agentPanelReadOnly')}</Text>
        </View>
    );

    const renderEditableRow = (args: {
        canEdit: boolean;
        expanded: 'permission' | 'model' | 'effort';
        icon: React.ComponentProps<typeof Ionicons>['name'];
        label: string;
        onPress: () => void;
        testID: string;
        value: string;
    }) => {
        const contents = (
            <>
                <Ionicons name={args.icon} size={16} color={theme.colors.textSecondary} />
                {renderRowText(args.label, args.value)}
                <Text style={[styles.rowState, args.canEdit && styles.rowStateEditable]}>
                    {args.canEdit ? t('sessionInfo.agentPanelEditable') : t('sessionInfo.agentPanelReadOnly')}
                </Text>
                {args.canEdit ? (
                    <Ionicons
                        name={visibleExpanded === args.expanded ? 'chevron-up' : 'chevron-down'}
                        size={13}
                        color={theme.colors.textSecondary}
                    />
                ) : null}
            </>
        );

        if (!args.canEdit) {
            return (
                <View
                    accessibilityLabel={`${args.label}: ${args.value}. ${t('sessionInfo.agentPanelReadOnly')}`}
                    style={styles.configRow}
                    testID={args.testID}
                >
                    {contents}
                </View>
            );
        }

        return (
            <Pressable
                accessibilityHint={t('agentInput.taskPermission.changesNextMessages')}
                accessibilityLabel={`${args.label}: ${args.value}`}
                accessibilityRole="button"
                accessibilityState={{ expanded: visibleExpanded === args.expanded }}
                style={(pressableState) => [styles.configRow, pressableState.pressed && styles.rowPressed]}
                onPress={args.onPress}
                testID={args.testID}
            >
                {contents}
            </Pressable>
        );
    };

    // Inline option list shown under an expanded editable row.
    const renderOptions = (
        label: string,
        options: { key: string; name: string }[],
        currentKey: string | undefined,
        onSelect: (key: string) => void | Promise<void>,
    ) => (
        <View
            accessibilityLabel={label}
            accessibilityRole="radiogroup"
            style={styles.optionList}
        >
            {options.map((opt) => {
                const isSelected = opt.key === currentKey;
                return (
                    <Pressable
                        key={opt.key}
                        style={(p) => [styles.optionRow, p.pressed && styles.rowPressed]}
                        onPress={() => void onSelect(opt.key)}
                        accessibilityLabel={opt.name}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: isSelected }}
                        testID={`session-agent-panel-${visibleExpanded}-option-${opt.key}`}
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
                <View
                    {...(Platform.OS === 'web' ? {
                        dataSet: {
                            happyMotion: 'popover',
                            happyMotionAlign: 'right',
                            happyMotionSide: 'below',
                        },
                    } as any : {})}
                    style={styles.configBox}
                    testID="session-agent-panel"
                >
                    <View style={styles.section} testID="session-agent-panel-runtime-location">
                        <Text style={styles.sectionTitle}>{t('sessionInfo.agentPanelRuntimeLocation')}</Text>
                        <View style={styles.sectionBody}>
                            {renderReadOnlyRow({
                                icon: 'desktop-outline',
                                label: t('sessionInfo.agentPanelMachineStatus'),
                                testID: 'session-agent-panel-machine-status',
                                value: `${machineName ?? t('agentInput.noMachinesAvailable')} · ${online ? t('status.online') : t('status.offline')}`,
                            })}
                            {renderReadOnlyRow({
                                icon: 'globe-outline',
                                label: t('sessionInfo.agentPanelAddress'),
                                testID: 'session-agent-panel-address',
                                value: metadata?.host ?? t('settingsAccount.notAvailable'),
                            })}
                            {renderReadOnlyRow({
                                icon: 'folder-outline',
                                label: t('sessionInfo.agentPanelWorkingDirectory'),
                                testID: 'session-agent-panel-working-directory',
                                value: pathName ?? t('settingsAccount.notAvailable'),
                            })}
                        </View>
                    </View>

                    <View style={styles.section} testID="session-agent-panel-current-execution">
                        <Text style={styles.sectionTitle}>{t('sessionInfo.agentPanelCurrentExecution')}</Text>
                        {!online ? (
                            <View style={styles.offlineNotice} testID="session-agent-panel-offline-notice">
                                <Ionicons name="cloud-offline-outline" size={16} color={theme.colors.warning} />
                                <Text style={styles.offlineNoticeText}>{t('sessionInfo.agentPanelOfflineNotice')}</Text>
                            </View>
                        ) : null}
                        <View style={styles.sectionBody}>
                            {renderReadOnlyRow({
                                icon: 'terminal-outline',
                                label: t('sessionInfo.agentPanelAgent'),
                                testID: 'session-agent-panel-agent',
                                value: agentLabel,
                            })}
                            {infoExperience.showModelDetails && modelMode?.name
                                ? renderEditableRow({
                                    canEdit: canEditModel,
                                    expanded: 'model',
                                    icon: 'hardware-chip-outline',
                                    label: t('sessionInfo.agentPanelModel'),
                                    onPress: () => toggle('model'),
                                    testID: 'session-agent-panel-model',
                                    value: modelMode.name,
                                })
                                : null}
                            {infoExperience.showModelDetails && visibleExpanded === 'model'
                                ? renderOptions(t('sessionInfo.agentPanelModel'), availableModels, modelMode?.key, applyModel)
                                : null}
                            {infoExperience.showModelDetails && effortLevel?.name
                                ? renderEditableRow({
                                    canEdit: canEditEffort,
                                    expanded: 'effort',
                                    icon: 'bulb-outline',
                                    label: t('sessionInfo.agentPanelEffort'),
                                    onPress: () => toggle('effort'),
                                    testID: 'session-agent-panel-effort',
                                    value: effortLevel.name,
                                })
                                : null}
                            {infoExperience.showModelDetails && visibleExpanded === 'effort'
                                ? renderOptions(t('sessionInfo.agentPanelEffort'), availableEffortLevels, effortLevel?.key, applyEffort)
                                : null}
                            {infoExperience.showPermission
                                ? renderEditableRow({
                                    canEdit: canEditPermission,
                                    expanded: 'permission',
                                    icon: permissionIcon(taskPermission.level),
                                    label: t('sessionInfo.agentPanelPermissions'),
                                    onPress: () => toggle('permission'),
                                    testID: 'session-agent-panel-permission',
                                    value: permissionValue,
                                })
                                : null}
                            {infoExperience.showPermission && visibleExpanded === 'permission'
                                ? renderOptions(t('sessionInfo.agentPanelPermissions'), permissionOptions, taskPermission.level ?? 'confirm', applyPermission)
                                : null}
                        </View>
                    </View>

                    <View style={styles.section} testID="session-agent-panel-session-management">
                        <Text style={styles.sectionTitle}>{t('sessionInfo.agentPanelSessionManagement')}</Text>
                        <View style={styles.sectionBody}>
                            {canCopySessionId ? (
                                <Pressable
                                    accessibilityLabel={t('sessionInfo.happySessionId')}
                                    accessibilityRole="button"
                                    style={(p) => [styles.actionRow, p.pressed && styles.rowPressed]}
                                    onPress={copySessionId}
                                    testID="session-agent-panel-copy-session-id"
                                >
                                    <Ionicons name="copy-outline" size={16} color={theme.colors.text} />
                                    <Text style={styles.actionLabel} numberOfLines={1}>{t('sessionInfo.happySessionId')}</Text>
                                </Pressable>
                            ) : null}
                            {onShareSession ? (
                                <Pressable
                                    accessibilityLabel={t('sessionShare.shareSession')}
                                    accessibilityRole="button"
                                    style={(p) => [styles.actionRow, p.pressed && styles.rowPressed]}
                                    onPress={onShareSession}
                                    testID="session-agent-panel-share-session"
                                >
                                    <Ionicons name="share-social-outline" size={16} color={theme.colors.text} />
                                    <Text style={styles.actionLabel} numberOfLines={1}>{t('sessionShare.shareSession')}</Text>
                                    <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                                </Pressable>
                            ) : null}
                            <Pressable
                                accessibilityLabel={t('sessionInfo.viewDetails')}
                                accessibilityRole="button"
                                style={(p) => [styles.actionRow, p.pressed && styles.rowPressed]}
                                onPress={onViewDetails}
                                testID="session-agent-panel-view-details"
                            >
                                <Ionicons name="information-circle-outline" size={16} color={theme.colors.text} />
                                <Text style={styles.actionLabel} numberOfLines={1}>{t('sessionInfo.viewDetails')}</Text>
                                <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                            </Pressable>
                        </View>
                    </View>
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
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingTop: 8,
        zIndex: 11,
    },
    configBox: {
        width: '100%',
        maxWidth: 680,
        backgroundColor: theme.colors.input.background,
        borderRadius: Platform.select({ default: 16, android: 20 }),
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        paddingVertical: 8,
        paddingHorizontal: 8,
        gap: 2,
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 12,
        elevation: 8,
    },
    section: {
        gap: 4,
    },
    sectionTitle: {
        paddingTop: 6,
        paddingHorizontal: 10,
        fontSize: 11,
        lineHeight: 16,
        letterSpacing: 0.5,
        textTransform: 'uppercase',
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    },
    sectionBody: {
        borderRadius: 12,
        backgroundColor: theme.colors.surface,
        overflow: 'hidden',
    },
    configRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 12,
    },
    rowPressed: {
        backgroundColor: theme.colors.surfacePressed,
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
    rowText: {
        flex: 1,
        minWidth: 0,
        gap: 1,
    },
    rowLabel: {
        minWidth: 0,
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    },
    rowValue: {
        minWidth: 0,
        fontSize: 14,
        lineHeight: 18,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    },
    rowState: {
        flexShrink: 0,
        fontSize: 10,
        lineHeight: 14,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    },
    rowStateEditable: {
        color: theme.colors.accent,
        ...Typography.default('semiBold'),
    },
    offlineNotice: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginHorizontal: 2,
        paddingHorizontal: 12,
        paddingVertical: 9,
        borderRadius: 12,
        backgroundColor: theme.colors.warning + '14',
    },
    offlineNoticeText: {
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text,
        ...Typography.default('regular'),
    },
    actionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
        paddingHorizontal: 12,
        paddingVertical: 11,
        borderRadius: 12,
    },
    actionLabel: {
        flex: 1,
        minWidth: 0,
        fontSize: 14,
        lineHeight: 18,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    },
    optionList: {
        marginHorizontal: 6,
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
