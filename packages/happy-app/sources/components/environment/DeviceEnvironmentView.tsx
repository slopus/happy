import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { environmentRepairCommands, type EnvironmentComponentId } from '@slopus/happy-wire';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { FLEET_COMPONENT_IDS } from '@/environment/fleetModel';
import { describeEnvironmentCell, type EnvironmentCell, type EnvironmentRow } from '@/environment/environmentDashboard';
import { useEnvironmentDashboard, type EnvironmentDashboardController } from '@/hooks/useEnvironmentDashboard';
import { useHappyAction } from '@/hooks/useHappyAction';
import { Modal } from '@/modal';
import { t } from '@/text';
import { environmentComponentName, environmentIcons, environmentReason } from './environmentLabels';
import { useCodexAccounts } from '@/hooks/useCodexAccounts';
import { CodexAccountSection, CodexAccountBindingCell } from './CodexAccountSection';

const machineName = (row: EnvironmentRow) => row.machine.metadata?.displayName || row.machine.metadata?.host || row.machine.id;
const working = (cell: EnvironmentCell) => ['checking', 'queued', 'preparing', 'updating'].includes(cell.phase);

function cellStatus(cell: EnvironmentCell, online: boolean, connected = true): string {
    if (!connected) return t('deviceEnvironmentDashboard.previousResult');
    if (!online) return t('deviceEnvironmentDashboard.offline');
    switch (cell.phase) {
        case 'checking': return t('deviceEnvironmentDashboard.scanning');
        case 'queued': return t('deviceEnvironmentDashboard.queued');
        case 'preparing': return t('deviceEnvironmentDashboard.preparing');
        case 'updating': return t('deviceEnvironmentDashboard.updating');
        case 'uncertain': return t('deviceEnvironmentDashboard.uncertain');
        case 'unknown': return t('deviceEnvironment.stateUnknown');
        case 'changed': return t('deviceEnvironmentDashboard.changed');
        case 'failed': return t('deviceEnvironmentDashboard.failed');
    }
    switch (describeEnvironmentCell(cell).state) {
        case 'missing': return t('deviceEnvironment.notInstalled');
        case 'update': return t('deviceEnvironmentDashboard.available');
        case 'login': return t('deviceEnvironmentDashboard.pendingLogin');
        case 'pairing': return t('deviceEnvironmentDashboard.pendingPair');
        case 'optional-login': return t('deviceEnvironmentDashboard.certificateOptional');
        case 'ahead': return t('deviceEnvironmentDashboard.ahead');
        case 'source': return t('deviceEnvironmentDashboard.sourceUnknown');
        case 'unsupported': return t('deviceEnvironment.componentUnsupported');
        case 'manual': return t('deviceEnvironmentDashboard.handle');
        case 'unknown': return t('deviceEnvironment.stateUnknown');
        case 'latest': return t(cell.phase === 'succeeded' && cell.result?.changed ? 'deviceEnvironmentDashboard.succeeded' : 'deviceEnvironmentDashboard.latest');
    }
}

const Action = React.memo(({ title, label, testID, onPress, disabled, primary, icon }: {
    title: string; label?: string; testID: string; onPress(): void; disabled?: boolean; primary?: boolean;
    icon?: React.ComponentProps<typeof Ionicons>['name'];
}) => {
    const { theme } = useUnistyles();
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label ?? title} accessibilityState={{ disabled: Boolean(disabled) }}
        disabled={disabled} onPress={onPress} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={({ pressed }) => [styles.action, primary && styles.primary, !disabled && (hovered || pressed) && (primary ? styles.primaryPressed : styles.pressed), !disabled && focused && styles.focused, disabled && styles.disabled]}>
        {icon ? <Ionicons name={icon} size={15} color={primary ? theme.colors.button.primary.tint : theme.colors.textLink} /> : null}
        <Text numberOfLines={2} style={[styles.actionText, primary && styles.primaryText]}>{title}</Text>
    </Pressable>;
});

const EnvironmentContent = React.memo(({ controller }: { controller: EnvironmentDashboardController }) => {
    const accounts = useCodexAccounts();
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const [contentWidth, setContentWidth] = React.useState(Math.min(width, 1040));
    const [selected, setSelected] = React.useState<{ machineId: string; componentId: EnvironmentComponentId } | null>(null);
    const scroll = React.useRef<ScrollView>(null);
    const deviceScroll = React.useRef<ScrollView>(null);
    const [visibleMachineId, setVisibleMachineId] = React.useState<string | null>(null);
    const latest = React.useRef(controller); latest.current = controller;
    const narrow = contentWidth < 740;
    const labelWidth = narrow ? 112 : 180;
    const cellWidth = Math.max(narrow ? 208 : 224, (contentWidth - 32 - labelWidth) / Math.max(1, controller.rows.length));
    const connected = controller.connectionReady !== false;
    const busy = controller.scanning || controller.running || !connected;
    const candidates = controller.getCandidates();
    const onlineRows = controller.rows.filter(row => row.machine.active);
    const unverified = onlineRows.flatMap(row => Object.values(row.cells))
        .filter(cell => ['unknown', 'source'].includes(describeEnvironmentCell(cell).state)).length;
    const attention = controller.rows.filter(row => row.machine.active).flatMap(row => Object.values(row.cells))
        .filter(cell => { const action = describeEnvironmentCell(cell).action; return action && action !== 'upgrade'; }).length;
    const selectedRow = controller.rows.find(row => row.machine.id === selected?.machineId);
    const selectedCell = selected && selectedRow?.cells[selected.componentId];
    const selectedDeviceId = controller.rows.some(row => row.machine.id === visibleMachineId)
        ? visibleMachineId
        : controller.rows[0]?.machine.id ?? null;
    function focusDevice(machineId: string) {
        const index = controller.rows.findIndex(row => row.machine.id === machineId);
        if (index < 0) return;
        setVisibleMachineId(machineId);
        requestAnimationFrame(() => deviceScroll.current?.scrollTo({ x: index * cellWidth, animated: true }));
    }
    function showDetails(row: EnvironmentRow, componentId: EnvironmentComponentId) {
        setSelected({ machineId: row.machine.id, componentId });
        requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: false }));
    }
    const [, perform] = useHappyAction(async (row: EnvironmentRow, componentId: EnvironmentComponentId) => {
        if (latest.current.scanning || latest.current.running || latest.current.connectionReady === false) return;
        const cell = row.cells[componentId], description = describeEnvironmentCell(cell);
        if (description.action === 'upgrade') { await controller.update({ machineId: row.machine.id, componentId }); return; }
        if (!description.action || description.action === 'manual') { showDetails(row, componentId); return; }
        const action = description.action === 'install' ? t('deviceEnvironmentDashboard.install')
            : description.action === 'authenticate' ? t('deviceEnvironmentDashboard.login') : t('deviceEnvironmentDashboard.handle');
        const approved = await Modal.confirm(t('deviceEnvironmentDashboard.actionConfirmTitle'), t('deviceEnvironmentDashboard.actionConfirm', {
            machine: machineName(row), component: environmentComponentName(componentId), action, version: description.target ?? t('common.unknown'),
        }), { confirmText: action, cancelText: t('common.cancel') });
        if (approved && latest.current.rows.find(r => r.machine.id === row.machine.id)?.cells[componentId] === cell)
            await latest.current.runSingle(row.machine.id, componentId);
    });
    const [, confirmStopped] = useHappyAction(async (machineId: string) => {
        if (latest.current.scanning || latest.current.running || latest.current.connectionReady === false) return;
        const approved = await Modal.confirm(t('deviceEnvironmentDashboard.confirmStopped'), t('deviceEnvironmentDashboard.confirmStoppedMessage'), {
            confirmText: t('deviceEnvironmentDashboard.confirmStopped'), cancelText: t('common.cancel'),
        });
        if (approved) await latest.current.confirmStopped(machineId);
    });
    const renderCell = (row: EnvironmentRow, componentId: EnvironmentComponentId) => {
        const cell = row.cells[componentId], description = describeEnvironmentCell(cell), online = row.machine.active;
        const ready = connected && online && ['latest', 'optional-login'].includes(description.state) && !working(cell) && !['failed', 'uncertain'].includes(cell.phase);
        const action = description.action;
        const actionText = cell.phase === 'failed' && action === 'upgrade' ? t('deviceEnvironmentDashboard.retry')
            : action === 'upgrade' ? t('deviceEnvironmentDashboard.update') : action === 'install' ? t('deviceEnvironmentDashboard.install')
                : action === 'authenticate' ? t('deviceEnvironmentDashboard.login') : t('deviceEnvironmentDashboard.handle');
        return <View key={row.machine.id} style={[styles.cell, { width: cellWidth }, selected?.machineId === row.machine.id && selected.componentId === componentId && styles.selectedCell]}
            testID={`environment-component-${row.machine.id}-${componentId}`}>
            <Pressable accessibilityRole="button" accessibilityLabel={t('deviceEnvironmentDashboard.selectedAction', { machine: machineName(row), component: environmentComponentName(componentId), action: t('profile.details') })}
                onPress={() => showDetails(row, componentId)} style={({ pressed }) => [styles.versionButton, pressed && styles.pressed]}>
                <Text numberOfLines={1} style={[styles.version, !online && styles.secondary]}>
                    {cell.observation ? cell.observation.installed ? cell.observation.installedVersion ?? t('common.unknown') : t('deviceEnvironment.notInstalled') : t('common.unknown')}
                    {online && description.target && description.action === 'upgrade' ? ` → ${description.target}` : ''}
                </Text>
            </Pressable>
            <View style={styles.statusRow}>
                {connected && online && working(cell) ? <ActivityIndicator size="small" color={theme.colors.textLink} style={styles.spinner} /> : null}
                <Text numberOfLines={2} style={[styles.status, ready && styles.ready]}>{cellStatus(cell, online, connected)}</Text>
                {online && action ? <Action testID={`environment-action-${row.machine.id}-${componentId}`} title={actionText}
                    label={t('deviceEnvironmentDashboard.selectedAction', { machine: machineName(row), component: environmentComponentName(componentId), action: actionText })}
                    onPress={() => { void perform(row, componentId); }} disabled={busy || row.unresolved} /> : null}
            </View>
        </View>;
    };
    const reason = selectedCell ? environmentReason(selectedCell) : undefined;
    const repairReason = selectedCell?.reasonCode ?? selectedCell?.observation?.reasonCode
        ?? (selectedCell && ['login', 'optional-login', 'pairing'].includes(describeEnvironmentCell(selectedCell).state) ? 'authentication-missing' : undefined);
    const commands = selectedCell ? environmentRepairCommands(selectedCell.componentId, repairReason) : [];
    const batch = controller.batch;
    const summary = controller.running && batch ? t('deviceEnvironmentDashboard.batchProgress', { done: batch.done, total: batch.total })
        : controller.scanning ? t('deviceEnvironmentDashboard.scanning')
            : batch ? t('deviceEnvironmentDashboard.batchResult', batch)
                : controller.connectionReady === false ? t('deviceEnvironmentDashboard.waitingForConnection')
                    : !onlineRows.length ? t('deviceEnvironmentDashboard.noOnline')
                        : candidates.length ? t('deviceEnvironmentDashboard.updatesSummary', { count: candidates.length, machines: new Set(candidates.map(c => c.machineId)).size })
                            : unverified ? t('deviceEnvironmentDashboard.incompleteSummary', { count: unverified }) : t('deviceEnvironmentDashboard.allCurrent');
    return <View style={styles.container} onLayout={event => setContentWidth(event.nativeEvent.layout.width)} testID="environment-dashboard">
        <View style={styles.toolbar}>
            <View style={styles.summary} testID="environment-summary">
                <Text style={styles.summaryText}>{connected ? t('deviceEnvironmentDashboard.fleet', { total: controller.rows.length, online: onlineRows.length }) : t('deviceEnvironmentDashboard.fleetDisconnected', { total: controller.rows.length })}</Text>
                <Text style={styles.secondary}>{controller.connectionReady === false ? t('deviceEnvironmentDashboard.waitingForConnection') : controller.lastChecked ? t('deviceEnvironmentDashboard.lastChecked', { time: new Date(controller.lastChecked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : t('deviceEnvironmentDashboard.notChecked')}</Text>
            </View>
            <Action testID="environment-scan-all" title={t(controller.scanning ? 'deviceEnvironmentDashboard.scanning' : 'deviceEnvironmentDashboard.scan')} icon="refresh-outline"
                disabled={busy || !controller.rows.length} onPress={() => { void controller.scan(); }} />
        </View>
        <ScrollView ref={scroll} style={styles.scroller} contentContainerStyle={styles.scrollContent}>
            <CodexAccountSection controller={accounts} machines={controller.rows.map(row => ({ id: row.machine.id, name: machineName(row), active: row.machine.active }))} />
            {!controller.rows.length ? <Text style={styles.empty}>{t('deviceEnvironment.emptyFleet')}</Text> : <>
                {narrow ? <Text style={styles.hint}>{t('deviceEnvironmentDashboard.horizontalHint')}</Text> : null}
                {narrow && controller.rows.length > 1 ? <ScrollView horizontal showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.devicePicker} testID="environment-device-picker">
                    {controller.rows.map(row => <Pressable key={row.machine.id} testID={`environment-device-picker-${row.machine.id}`}
                        accessibilityRole="button" accessibilityState={{ selected: selectedDeviceId === row.machine.id }}
                        accessibilityLabel={machineName(row)} onPress={() => focusDevice(row.machine.id)}
                        style={({ pressed }) => [styles.devicePickerItem, selectedDeviceId === row.machine.id && styles.devicePickerItemSelected, pressed && styles.pressed]}>
                        <Text numberOfLines={1} style={[styles.devicePickerText, selectedDeviceId === row.machine.id && styles.devicePickerTextSelected]}>{machineName(row)}</Text>
                        <Text style={[styles.devicePickerStatus, connected && row.machine.active && styles.ready]}>{t(!connected ? 'deviceEnvironmentDashboard.previousResult' : row.machine.active ? 'deviceEnvironmentDashboard.online' : 'deviceEnvironmentDashboard.offline')}</Text>
                    </Pressable>)}
                </ScrollView> : null}
                <View style={styles.matrix} testID="environment-matrix">
                    <View style={{ width: labelWidth }}>
                        <View style={styles.columnHeader}><Text style={styles.secondary}>{t('deviceEnvironmentDashboard.tools')}</Text></View>
                        <View style={styles.accountLabel} testID="environment-codex-account-label"><Text style={styles.toolText}>{t('codexAccounts.defaultAccount')}</Text></View>
                        {FLEET_COMPONENT_IDS.map(componentId => {
                            const count = controller.getCandidates({ componentId }).length;
                            return <View key={componentId} style={styles.toolHeader} testID={`environment-tool-${componentId}`}>
                                <View style={styles.toolTitle}>{!narrow ? <Ionicons name={environmentIcons[componentId]} size={18} color={theme.colors.textSecondary} /> : null}
                                    <Text numberOfLines={2} style={styles.toolText}>{environmentComponentName(componentId)}</Text></View>
                                {count > 0 ? <Action title={t('deviceEnvironmentDashboard.updateType', { count })} testID={`environment-update-type-${componentId}`}
                                    disabled={busy} onPress={() => { void controller.update({ componentId }); }} /> : null}
                            </View>;
                        })}
                    </View>
                    <ScrollView ref={deviceScroll} horizontal style={styles.deviceScroller} contentContainerStyle={styles.devices} testID="environment-device-columns"
                        onMomentumScrollEnd={event => {
                            const index = Math.round(event.nativeEvent.contentOffset.x / cellWidth);
                            setVisibleMachineId(controller.rows[index]?.machine.id ?? null);
                        }}>
                        <View>
                            <View style={styles.tableRow}>{controller.rows.map(row => <View key={row.machine.id} style={[styles.columnHeader, { width: cellWidth }]} testID={`environment-device-${row.machine.id}`}>
                                <Text numberOfLines={1} style={styles.deviceName}>{machineName(row)}</Text>
                                <Text style={[styles.secondary, connected && row.machine.active && styles.ready]}>{t(!connected ? 'deviceEnvironmentDashboard.previousResult' : row.machine.active ? 'deviceEnvironmentDashboard.online' : 'deviceEnvironmentDashboard.offline')}</Text>
                            </View>)}</View>
                            <View style={[styles.tableRow, styles.accountRow]}>{controller.rows.map(row => <CodexAccountBindingCell key={row.machine.id}
                                controller={accounts} machine={{ id: row.machine.id, name: machineName(row) }} width={cellWidth} />)}</View>
                            {FLEET_COMPONENT_IDS.map(componentId => <View key={componentId} style={styles.tableRow}>{controller.rows.map(row => renderCell(row, componentId))}</View>)}
                        </View>
                    </ScrollView>
                </View>
            </>}
            {controller.rows.filter(row => row.unresolved).map(row => <View key={row.machine.id} style={styles.details}>
                <Text style={styles.detailTitle}>{machineName(row)} · {t('deviceEnvironmentDashboard.uncertain')}</Text>
                <Text style={styles.detailCopy}>{t('deviceEnvironmentDashboard.unresolvedHint')}</Text>
                <Action testID={`environment-confirm-stopped-${row.machine.id}`} title={t('deviceEnvironmentDashboard.confirmStopped')}
                    disabled={busy || !row.machine.active} onPress={() => { void confirmStopped(row.machine.id); }} />
            </View>)}
            {selectedCell && selectedRow ? <View style={styles.details} testID="environment-details">
                <View style={styles.detailHeader}><Text style={styles.detailTitle}>{machineName(selectedRow)} · {environmentComponentName(selectedCell.componentId)}</Text>
                    <Action title={t('sidebarLists.close')} testID="environment-details-close" onPress={() => setSelected(null)} /></View>
                <Text style={styles.detailCopy}>{cellStatus(selectedCell, selectedRow.machine.active, connected)}</Text>
                {selectedCell.phase === 'succeeded' && selectedCell.result?.status === 'succeeded' ? <Text style={connected ? styles.ready : styles.secondary}>{t('deviceEnvironment.completed')} · {selectedCell.result.before.installedVersion ?? t('deviceEnvironment.notInstalled')} → {selectedCell.result.after.installedVersion}</Text> : null}
                {reason ? <Text style={styles.detailCopy}>{reason}</Text> : null}
                {selectedCell.observation?.source.latestVersion ? <Text style={styles.detailCopy}>{t('deviceEnvironmentDashboard.target', { version: selectedCell.observation.source.latestVersion })} · {t('deviceEnvironmentDashboard.localSource')}</Text> : null}
                {selectedCell.observation?.capability === 'inspect-only' ? <Text style={styles.detailCopy}>{t('deviceEnvironment.inspectOnly')}</Text> : null}
                {commands.length ? <><Text style={styles.detailCopy}>{t('deviceEnvironmentDashboard.manualHint')}</Text>{commands.map(command => <Text selectable key={command} style={styles.command}>{command}</Text>)}</> : null}
            </View> : null}
        </ScrollView>
        <View style={styles.footer} testID="environment-footer">
            <View style={styles.footerCopy} accessibilityLiveRegion="polite">
                <Text style={styles.summaryText}>{summary}</Text>
                <Text style={styles.secondary}>{controller.running ? t('deviceEnvironmentDashboard.background') : [
                    unverified && !controller.scanning && (candidates.length > 0 || batch) ? t('deviceEnvironmentDashboard.incompleteSummary', { count: unverified }) : null,
                    attention ? t('deviceEnvironmentDashboard.attentionSummary', { count: attention }) : null,
                ].filter(Boolean).join(' · ') || t('deviceEnvironmentDashboard.verifyHint')}</Text>
            </View>
            <Action primary testID="environment-update-all" title={t('deviceEnvironmentDashboard.updateAll', { count: candidates.length })}
                disabled={busy || !candidates.length} onPress={() => { void controller.update({}); }} />
        </View>
    </View>;
});
const ConnectedEnvironment = React.memo(() => <EnvironmentContent controller={useEnvironmentDashboard()} />);
export const DeviceEnvironmentView = React.memo(({ controller }: { controller?: EnvironmentDashboardController }) => controller
    ? <EnvironmentContent controller={controller} /> : <ConnectedEnvironment />);

const styles = StyleSheet.create(theme => ({
    primaryPressed: { opacity: 0.85 },
    container: { flex: 1, minHeight: 0, width: '100%', maxWidth: Math.max(layout.maxWidth, 1180), alignSelf: 'center', backgroundColor: theme.colors.surface },
    toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 12, gap: 12 },
    summary: { flex: 1, gap: 3 }, summaryText: { color: theme.colors.text, fontSize: 13, lineHeight: 19, ...Typography.default() },
    secondary: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18, ...Typography.default() },
    scroller: { flex: 1, minHeight: 0 }, scrollContent: { paddingHorizontal: 16, paddingBottom: 8 },
    matrix: { flexDirection: 'row', alignItems: 'flex-start', minWidth: 0 }, deviceScroller: { flex: 1, minWidth: 0 }, devices: { flexGrow: 1 }, tableRow: { flexDirection: 'row' },
    accountRow: { zIndex: 10 },
    accountLabel: { height: 88, paddingRight: 8, paddingVertical: 18, justifyContent: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    columnHeader: { height: 64, paddingHorizontal: 10, justifyContent: 'center', gap: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    deviceName: { color: theme.colors.text, fontSize: 14, lineHeight: 20, ...Typography.default('semiBold') },
    toolHeader: { height: 76, paddingVertical: 8, paddingRight: 8, justifyContent: 'center', gap: 3, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    toolTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 }, toolText: { flex: 1, fontSize: 13, lineHeight: 18, color: theme.colors.text, ...Typography.default('semiBold') },
    cell: { height: 76, paddingHorizontal: 10, paddingVertical: 9, justifyContent: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    selectedCell: { backgroundColor: theme.colors.surfaceSelected }, versionButton: { paddingVertical: 2, borderRadius: 4 },
    version: { color: theme.colors.text, fontSize: 13, lineHeight: 20, ...Typography.mono() }, statusRow: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 30 },
    status: { flex: 1, color: theme.colors.textSecondary, fontSize: 11, lineHeight: 15, ...Typography.default() }, spinner: { transform: [{ scale: 0.7 }], width: 16 },
    ready: { color: theme.colors.status.connected, fontSize: 12, lineHeight: 18 },
    action: { minHeight: Platform.OS === 'web' ? 30 : 40, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, alignSelf: 'flex-start' },
    actionText: { color: theme.colors.textLink, fontSize: 12, lineHeight: 17, ...Typography.default('semiBold') },
    primary: { minHeight: 42, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: theme.colors.button.primary.background, alignSelf: 'center' },
    primaryText: { color: theme.colors.button.primary.tint }, pressed: { backgroundColor: theme.colors.surfacePressed }, focused: { backgroundColor: theme.colors.surfaceSelected, outlineWidth: 1, outlineColor: theme.colors.textLink }, disabled: { opacity: 0.45 },
    footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: 16, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    footerCopy: { flex: 1, gap: 4 }, hint: { color: theme.colors.textSecondary, fontSize: 12, paddingVertical: 4 }, empty: { color: theme.colors.textSecondary, padding: 20 },
    devicePicker: { gap: 8, paddingBottom: 10 }, devicePickerItem: { minWidth: 132, maxWidth: 196, minHeight: 50, paddingHorizontal: 10, paddingVertical: 7, justifyContent: 'center', gap: 2, borderRadius: 8, backgroundColor: theme.colors.surfaceHigh },
    devicePickerItemSelected: { backgroundColor: theme.colors.surfaceSelected }, devicePickerText: { color: theme.colors.text, fontSize: 12, lineHeight: 17, ...Typography.default('semiBold') },
    devicePickerTextSelected: { color: theme.colors.textLink }, devicePickerStatus: { color: theme.colors.textSecondary, fontSize: 11, lineHeight: 15, ...Typography.default() },
    details: { padding: 14, marginTop: 12, borderRadius: 8, gap: 6, backgroundColor: theme.colors.surfaceHigh }, detailHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    detailTitle: { flex: 1, color: theme.colors.text, fontSize: 13, ...Typography.default('semiBold') }, detailCopy: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 19 },
    command: { color: theme.colors.text, backgroundColor: theme.colors.surfaceSelected, padding: 8, borderRadius: 4, fontSize: 12, ...Typography.mono() },
}));
