import { registerConversationPanelClose } from '@/navigation/conversationPanelNavigation';
import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useIsFocused } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useMachine } from '@/sync/storage';
import { getFirstSubmissionScope, subscribeFirstSubmissionScope } from '@/sync/firstSubmissionScope';
import { useMachineDelegationRoles } from '@/hooks/useMachineDelegationRoles';
import { useRightSwipePanel } from '@/components/RightSwipePanelHost';
import { CodingAgentIcon } from '@/components/codingAgents/CodingAgentIcon';
import type { SubagentInspectorSelection } from '@/components/subagent/SubagentInspectorContext';
import { t } from '@/text';

/** A conversation-owned, read-only inspector. The receipt remains a historical
 * snapshot; only a successful machine-directory read enables settings editing. */
export function RoleDetailPanel({ selection, onClose, surfaceColor }: {
    selection: SubagentInspectorSelection; onClose: () => void; surfaceColor?: string;
}) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const panel = useRightSwipePanel();
    const focused = useIsFocused();
    const owner = React.useSyncExternalStore(subscribeFirstSubmissionScope, getFirstSubmissionScope, getFirstSubmissionScope);
    const machineId = selection.machineId ?? '';
    const machine = useMachine(machineId);
    const ownerCurrent = !!owner && owner === selection.roleOwner;
    const machineReady = ownerCurrent && !!machine?.active && machine.metadata?.delegationRoles === 1;
    const controller = useMachineDelegationRoles(machineId, machineReady, focused && ownerCurrent);
    const savedRole = selection.savedRole;
    const live = ownerCurrent ? controller.roles.find(role => role.id === selection.roleId) : undefined;
    const canEdit = !!live && machineReady && controller.connected && !controller.loading && !controller.error;
    const role = live ?? savedRole;
    const close = React.useCallback(() => {
        // Web drawer geometry is controlled by the parent's open flag. It
        // must not wait for a native spring completion to release that flag.
        if (Platform.OS !== 'web' && panel?.isOpen) panel.closePanel(onClose);
        else onClose();
    }, [panel, onClose]);
    React.useEffect(() => { if (focused) return registerConversationPanelClose({}, close); }, [focused, close]);
    React.useEffect(() => panel?.registerBackHandler(() => { close(); return true; }), [panel, close]);
    React.useEffect(() => {
        if (Platform.OS !== 'web' || panel || !focused || typeof document === 'undefined') return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.repeat) return;
            // Settings and confirmation portals own their keys while this
            // non-modal inspector remains mounted underneath.
            const dialogOpen = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
                .some(node => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; });
            if (dialogOpen) return;
            event.preventDefault(); event.stopPropagation(); close();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [panel, focused, close]);
    let snapshotHint = t('delegation.roleSavedSnapshot');
    if (!machineReady || !controller.connected) snapshotHint = t('delegation.roleOfflineSnapshot');
    else if (controller.error) snapshotHint = t('delegation.roleSnapshotReadFailed');
    else if (!controller.loading && !live) snapshotHint = t('delegation.roleMissingSnapshot');
    return <View style={[styles.root, surfaceColor !== undefined && { backgroundColor: surfaceColor }]} testID="role-detail-panel">
        <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>{t('delegation.roleDetails')}</Text>
            <Action label={t('sidebarLists.close')} testID="role-detail-close" onPress={close} icon={<Ionicons name="close-outline" size={22} color={theme.colors.text} />} />
        </View>
        {!ownerCurrent || !role || !machineId ? <Text style={styles.notice} accessibilityRole="alert" testID="role-detail-owner-changed">{t('delegation.ownerChanged')}</Text>
            : <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
                <View style={styles.identity}><CodingAgentIcon agent={role.agent} size={28} /><Text style={styles.name}>{role.name}</Text></View>
                {!live ? <Text style={styles.notice} testID="role-detail-snapshot-notice">{snapshotHint}</Text> : null}
                {controller.loading ? <View style={styles.loading} testID="role-detail-loading"><ActivityIndicator size="small" color={theme.colors.textLink} /><Text style={styles.secondary}>{t('common.loading')}</Text></View> : null}
                {controller.error ? <Text accessibilityRole="alert" style={styles.error} testID="role-detail-error">{controller.error}</Text> : null}
                <Field label={t('delegation.description')} value={role.description} />
                <Field label={t('delegation.machine')} value={machine?.metadata?.displayName ?? machine?.metadata?.host ?? machineId} />
                <Field label={t('delegation.agent')} value={role.agent === 'codex' ? 'Codex' : 'Antigravity'} />
                <Field label={t('delegation.model')} value={role.model ?? t('delegation.nativeDefault')} />
                <Field label={t('delegation.effort')} value={role.effort ?? t('delegation.nativeDefault')} />
                <Field label={t('delegation.autoDelegate')} value={t(role.autoDelegate ? 'common.yes' : 'common.no')} />
                <Field label={t('delegation.roleId')} value={role.id} testID="role-detail-id" />
                <View style={styles.actions}>
                    <Action label={t('delegation.openRoleSettings')} testID="role-detail-edit" disabled={!canEdit} onPress={() => {
                        if (!canEdit || !controller.isCurrent() || getFirstSubmissionScope() !== selection.roleOwner) return;
                        router.push({ pathname: '/settings/delegation-roles', params: { machineId, roleId: role.id, desktopModal: '1' } });
                    }} />
                    <Action label={t('delegation.refresh')} testID="role-detail-refresh" disabled={!machineReady || !controller.connected || controller.loading} onPress={() => { void controller.refresh(); }} />
                </View>
            </ScrollView>}
    </View>;
}

function Field({ label, value, testID }: { label: string; value: string; testID?: string }) {
    return <View style={styles.field} testID={testID}><Text style={styles.secondary}>{label}</Text><Text selectable style={styles.value}>{value}</Text></View>;
}
function Action({ label, onPress, disabled, icon, testID }: { label: string; onPress: () => void; disabled?: boolean; icon?: React.ReactNode; testID: string }) {
    const [focused, setFocused] = React.useState(false);
    return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} testID={testID}
        onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={(state: { pressed: boolean; hovered?: boolean }) => [styles.action, !!icon && styles.iconAction, !disabled && (state.pressed || state.hovered) && styles.pressed, focused && styles.focused, disabled && styles.disabled]}>
        {icon ?? <Text style={styles.actionLabel}>{label}</Text>}
    </Pressable>;
}
const styles = StyleSheet.create(theme => ({
    root: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface },
    header: { minHeight: 62, paddingHorizontal: 16, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.divider },
    title: { ...Typography.default('semiBold'), fontSize: 17, lineHeight: 24, color: theme.colors.text, flex: 1, minWidth: 0 },
    body: { padding: 18, gap: 18 },
    identity: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    name: { ...Typography.default('semiBold'), fontSize: 17, lineHeight: 25, color: theme.colors.text, flex: 1, minWidth: 0 },
    field: { gap: 5 },
    secondary: { ...Typography.default(), fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary },
    value: { ...Typography.default(), fontSize: 14, lineHeight: 22, color: theme.colors.text },
    notice: { ...Typography.default(), fontSize: 12, lineHeight: 19, color: theme.colors.textSecondary, paddingHorizontal: 18, paddingVertical: 12 },
    error: { ...Typography.default(), fontSize: 12, lineHeight: 19, color: theme.colors.textDestructive },
    loading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 4 },
    action: { minHeight: 42, paddingVertical: 9, paddingHorizontal: 12, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 8, backgroundColor: theme.colors.surface, alignItems: 'center', justifyContent: 'center' },
    iconAction: { width: 42, padding: 8, backgroundColor: 'transparent', borderColor: 'transparent' },
    actionLabel: { ...Typography.default('semiBold'), fontSize: 13, lineHeight: 20, color: theme.colors.text },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    focused: { borderColor: theme.colors.textLink },
    disabled: { opacity: 0.45 },
}));
