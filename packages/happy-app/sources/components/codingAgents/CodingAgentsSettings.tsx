import * as React from 'react';
import { View, Text, Pressable, Switch, ActivityIndicator } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { CodingAgentIdSchema, type CodingAgentId, type CodingAgentObservation } from '@slopus/happy-wire';
import { useAllMachines, useSettingMutable, storage } from '@/sync/storage';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { isMachineOnline } from '@/utils/machineUtils';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { t } from '@/text';
import { CodingAgentIcon } from './CodingAgentIcon';
import { inspectCodingAgents, updateCodingAgent } from './codingAgentOps';
export const codingAgentLabels: Record<CodingAgentId, string> = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode', antigravity: 'Antigravity', gemini: 'Gemini CLI', openclaw: 'OpenClaw' };
export default function CodingAgentsSettings() {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams<{ machineId?: string }>();
    const machines = useAllMachines({ includeOffline: true });
    const draftMachine = useNewSessionDraft(s => s.selectedMachineId);
    const [machineId, setMachineId] = React.useState(params.machineId || draftMachine || machines[0]?.id || '');
    React.useEffect(() => { if (params.machineId) setMachineId(params.machineId); }, [params.machineId]);
    React.useEffect(() => { if (!machineId && machines.length) setMachineId(draftMachine || machines[0]!.id); }, [machineId, draftMachine, machines]);
    const machine = machines.find(item => item.id === machineId);
    const online = !!machine && isMachineOnline(machine);
    const [configured, setConfigured] = useSettingMutable('codingAgentMachines');
    const enabled = configured[machineId] ?? ['codex'];
    const [observations, setObservations] = React.useState<CodingAgentObservation[]>([]);
    const [busy, setBusy] = React.useState<'inspect' | CodingAgentId | null>(null);
    const [checking, setChecking] = React.useState<CodingAgentId | null>(null);
    const [rowNotices, setRowNotices] = React.useState<Partial<Record<CodingAgentId, string>>>({});
    const [notice, setNotice] = React.useState('');
    const generation = React.useRef(0);
    const inFlight = React.useRef(false);
    const refresh = React.useCallback(async (checkUpdates: boolean, id?: CodingAgentId) => {
        if (!online || inFlight.current) return;
        inFlight.current = true;
        const current = generation.current;
        setBusy(id ?? 'inspect'); setChecking(id ?? null); setNotice('');
        if (id) setRowNotices(items => ({ ...items, [id]: undefined }));
        try {
            const result = id ? await inspectCodingAgents(machineId, checkUpdates, id) : await inspectCodingAgents(machineId, checkUpdates);
            if (current === generation.current) setObservations(items => id
                ? [...items.filter(item => item.id !== id), ...result.agents.filter(item => item.id === id)]
                : result.agents);
        } catch {
            if (current === generation.current) {
                if (id) setRowNotices(items => ({ ...items, [id]: t('codingAgents.unavailable') }));
                else setNotice(t('codingAgents.unavailable'));
            }
        } finally {
            if (current === generation.current) { inFlight.current = false; setBusy(null); setChecking(null); }
        }
    }, [machineId, online]);
    React.useEffect(() => {
        generation.current += 1;
        setObservations([]); setNotice(''); setRowNotices({}); setBusy(null); setChecking(null); inFlight.current = false;
        void refresh(false);
        return () => { generation.current += 1; };
    }, [refresh]);
    const toggle = (id: CodingAgentId, value: boolean) => {
        // Read the shared store at the action boundary so another settings view
        // cannot be overwritten by a stale render from this page.
        const latest = storage.getState().settings.codingAgentMachines;
        const selection = latest[machineId] ?? ['codex'];
        setConfigured({ ...latest, [machineId]: value ? [...new Set([...selection, id])] : selection.filter(agent => agent !== id) });
    };
    const update = async (agent: CodingAgentObservation) => {
        if (!agent.updateToken || inFlight.current || !online) return;
        inFlight.current = true;
        const current = generation.current;
        setBusy(agent.id); setNotice('');
        setRowNotices(items => ({ ...items, [agent.id]: undefined }));
        try {
            const result = await updateCodingAgent(machineId, agent.id, agent.updateToken);
            if (current !== generation.current) return;
            setRowNotices(items => ({ ...items, [agent.id]: t(result.success ? 'codingAgents.updated' : 'codingAgents.failed') }));
            // Consume the preview token even on failure; a retry requires a new
            // user-triggered check and never silently replays an install.
            setObservations(items => items.map(item => item.id === agent.id ? result.agent ?? { ...item, updateToken: undefined } : item));
        } catch {
            if (current === generation.current) { setRowNotices(items => ({ ...items, [agent.id]: t('codingAgents.failed') })); setObservations(items => items.map(item => item.id === agent.id ? { ...item, updateToken: undefined } : item)); }
        } finally { if (current === generation.current) { inFlight.current = false; setBusy(null); } }
    };
    return <ItemList>
        <ItemGroup title={t('codingAgents.machine')}>
            {machines.map(item => <Item key={item.id} title={item.metadata?.displayName || item.metadata?.host || item.id}
                subtitle={isMachineOnline(item) ? t('codingAgents.online') : t('codingAgents.offline')}
                disabled={!!busy && busy !== 'inspect'} showChevron={false} onPress={() => setMachineId(item.id)}
                rightElement={item.id === machineId ? <Ionicons name="checkmark" size={20} color={theme.colors.accent} /> : undefined} />)}
        </ItemGroup>
        <ItemGroup title={t('settings.codingAgents')} footer={t('codingAgents.explanation')}>
            <View style={styles.tools}>
                <Text style={styles.secondary}>{enabled.length ? `${t('codingAgents.enabledCount')} ${enabled.length}` : t('codingAgents.noneEnabled')}</Text>
                {busy === 'inspect' ? <ActivityIndicator size="small" color={theme.colors.textLink} /> : null}
            </View>
            {CodingAgentIdSchema.options.map(id => {
                const agent = observations.find(item => item.id === id);
                const installed = agent?.installed === true || machine?.metadata?.cliAvailability?.[id] === true;
                const status = !online ? t('codingAgents.offline') : !installed ? t('codingAgents.notInstalled') : agent?.version ? `CLI ${agent.version}` : t('codingAgents.detected');
                return <View key={id} style={styles.row} testID={`coding-agent-row-${id}`}>
                    <CodingAgentIcon agent={id} size={28} />
                    <View style={styles.content}>
                        <Text style={styles.title}>{codingAgentLabels[id]}</Text>
                        <Text style={styles.secondary}>{status}{agent?.latestVersion ? ` · ${t('codingAgents.latest')} ${agent.latestVersion}` : ''}</Text>
                        {agent?.reason === 'manual-update' ? <Text style={styles.secondary}>{t('codingAgents.manualUpdate')}</Text> : null}
                        {agent?.reason === 'check-failed' ? <Text style={styles.secondary}>{t('codingAgents.checkFailed')}</Text> : null}
                        {rowNotices[id] ? <Text accessibilityRole="alert" style={styles.secondary}>{rowNotices[id]}</Text> : null}
                    </View>
                    <View style={styles.actions}>
                        <Pressable testID={`coding-agent-check-${id}`} accessibilityRole="button" accessibilityLabel={`${t('codingAgents.check')} ${codingAgentLabels[id]}`}
                            disabled={!online || !!busy} onPress={() => void refresh(true, id)}
                            style={({ pressed }) => [styles.action, pressed && styles.pressed, (!online || !!busy) && styles.disabled]}>
                            {checking === id ? <ActivityIndicator size="small" color={theme.colors.textLink} /> : null}
                            <Text style={styles.actionText}>{t('codingAgents.check')}</Text>
                        </Pressable>
                        {agent?.updateToken ? <Pressable accessibilityRole="button" accessibilityLabel={`${t('codingAgents.update')} ${codingAgentLabels[id]}`} disabled={!!busy || !online} onPress={() => void update(agent)} style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
                            {busy === id && checking !== id ? <ActivityIndicator size="small" color={theme.colors.textLink} /> : <Ionicons name="download-outline" size={14} color={theme.colors.textLink} />}
                            <Text style={styles.actionText}>{t('codingAgents.update')} {agent.latestVersion}</Text>
                        </Pressable> : null}
                    </View>
                    <Switch testID={`coding-agent-enable-${id}`} accessibilityLabel={`${t('codingAgents.enable')} ${codingAgentLabels[id]}`} value={enabled.includes(id)} disabled={!machineId || !!busy || (!installed && !enabled.includes(id))} onValueChange={value => toggle(id, value)}
                        trackColor={{ false: theme.colors.divider, true: theme.colors.accent }} />
                </View>;
            })}
            {notice ? <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text> : null}
        </ItemGroup>
    </ItemList>;
}
const styles = StyleSheet.create(theme => ({
    tools: { padding: 16, gap: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' },
    row: { padding: 16, gap: 14, flexDirection: 'row', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    content: { flex: 1, minWidth: 0, gap: 4 }, title: { color: theme.colors.text, fontSize: 16, fontWeight: '600' },
    actions: { gap: 4, alignItems: 'flex-start', flexShrink: 0 },
    secondary: { color: theme.colors.textSecondary, fontSize: 13 },
    action: { alignSelf: 'flex-start', borderRadius: 8, padding: 8, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: theme.colors.surface },
    actionText: { color: theme.colors.textLink, fontSize: 13 }, pressed: { backgroundColor: theme.colors.surfacePressed }, disabled: { opacity: 0.5 },
    notice: { color: theme.colors.textSecondary, padding: 16 },
}));
