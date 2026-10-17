import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useHappyAction } from '@/hooks/useHappyAction';
import { useAllMachines } from '@/sync/storage';
import { collectMachineChoices } from '@/sync/machineChoices';
import {
    machineGetProxyConfig,
    machineSetProxyConfig,
    type ProxyConfig,
    type ProxyManualConfig,
    type ProxyMode,
    type ProxyProtocol,
    type ProxyStatus,
} from '@/sync/ops';
import { useUnistyles } from 'react-native-unistyles';

const MODES: ProxyMode[] = ['env', 'system', 'pac', 'manual', 'off'];
const PROTOCOLS: ProxyProtocol[] = ['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h'];

const EMPTY_MANUAL: ProxyManualConfig = { protocol: 'http', host: '', port: 0 };

function modeTitle(mode: ProxyMode): string {
    switch (mode) {
        case 'off': return t('settingsProxy.modeOff');
        case 'env': return t('settingsProxy.modeEnv');
        case 'system': return t('settingsProxy.modeSystem');
        case 'pac': return t('settingsProxy.modePac');
        case 'manual': return t('settingsProxy.modeManual');
    }
}

/** The remote configuration never carries the password; the draft keeps a placeholder. */
function toDraft(status: ProxyStatus): ProxyConfig {
    const manual = status.config.manual;
    return {
        mode: status.config.mode,
        manual: manual
            ? {
                protocol: manual.protocol,
                host: manual.host,
                port: manual.port,
                username: manual.username,
                // An empty string means "keep the stored password" for this screen.
                password: undefined,
            }
            : { ...EMPTY_MANUAL },
        pacUrl: status.config.pacUrl,
        noProxy: status.config.noProxy,
        useForChildProcesses: status.config.useForChildProcesses,
    };
}

export default React.memo(function ProxySettingsScreen() {
    const { theme } = useUnistyles();
    const machines = useAllMachines({ includeOffline: true });
    const choices = React.useMemo(
        () => collectMachineChoices(machines).sort((left, right) => (
            Number(right.online) - Number(left.online) || right.activeAt - left.activeAt
        )),
        [machines],
    );

    const [selectedId, setSelectedId] = React.useState<string | null>(null);
    const selected = choices.find((choice) => choice.id === selectedId) ?? choices[0];
    const [draft, setDraft] = React.useState<ProxyConfig | null>(null);
    const [status, setStatus] = React.useState<ProxyStatus | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [reloadToken, setReloadToken] = React.useState(0);

    React.useEffect(() => {
        if (!selected || !selected.online) {
            setDraft(null);
            setStatus(null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        (async () => {
            try {
                const next = await machineGetProxyConfig(selected.id);
                if (cancelled) return;
                setStatus(next);
                setDraft(toDraft(next));
            } catch {
                if (cancelled) return;
                // The daemon may be on an older CLI: keep the screen usable.
                setStatus(null);
                setDraft({
                    mode: 'env',
                    manual: { ...EMPTY_MANUAL },
                    noProxy: [],
                    useForChildProcesses: true,
                });
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [selected?.id, selected?.online, reloadToken]);

    const apply = React.useCallback(async (next: ProxyConfig) => {
        if (!selected) return;
        const result = await machineSetProxyConfig(selected.id, next);
        setStatus(result);
        setDraft(toDraft(result));
    }, [selected?.id]);

    const [saving, save] = useHappyAction(async () => {
        if (!draft) return;
        await apply(draft);
        Modal.alert(t('settingsProxy.saved'), selected?.name ?? '');
    });

    const update = React.useCallback((patch: Partial<ProxyConfig>) => {
        setDraft((current) => (current ? { ...current, ...patch } : current));
    }, []);

    const updateManual = React.useCallback((patch: Partial<ProxyManualConfig>) => {
        setDraft((current) => (current ? {
            ...current,
            mode: 'manual',
            manual: { ...EMPTY_MANUAL, ...current.manual, ...patch },
        } : current));
    }, []);

    const editText = React.useCallback(async (
        title: string,
        value: string,
        placeholder: string,
        inputType?: 'default' | 'numeric' | 'secure-text',
    ): Promise<string | null> => {
        return await Modal.prompt(title, undefined, { defaultValue: value, placeholder, inputType });
    }, []);

    const editHost = React.useCallback(async () => {
        const value = await editText(t('settingsProxy.host'), draft?.manual?.host ?? '', '127.0.0.1');
        if (value !== null) updateManual({ host: value.trim() });
    }, [draft?.manual?.host, editText, updateManual]);

    const editPort = React.useCallback(async () => {
        const current = draft?.manual?.port;
        const value = await editText(t('settingsProxy.port'), current ? String(current) : '', '7890', 'numeric');
        const port = Number(value);
        if (value !== null && Number.isInteger(port) && port > 0 && port < 65536) {
            updateManual({ port });
        }
    }, [draft?.manual?.port, editText, updateManual]);

    const editUsername = React.useCallback(async () => {
        const value = await editText(t('settingsProxy.username'), draft?.manual?.username ?? '', t('settingsProxy.notSet'));
        if (value !== null) updateManual({ username: value.trim() || undefined });
    }, [draft?.manual?.username, editText, updateManual]);

    const editPassword = React.useCallback(async () => {
        const value = await editText(t('settingsProxy.password'), '', '', 'secure-text');
        if (value !== null) updateManual({ password: value });
    }, [editText, updateManual]);

    const editPacUrl = React.useCallback(async () => {
        const value = await editText(t('settingsProxy.pacUrl'), draft?.pacUrl ?? '', 'http://wpad.example.com/proxy.pac');
        if (value !== null) update({ pacUrl: value.trim() || undefined });
    }, [draft?.pacUrl, editText, update]);

    const editBypass = React.useCallback(async () => {
        const value = await editText(
            t('settingsProxy.bypass'),
            (draft?.noProxy ?? []).join(', '),
            '*.internal.example, 10.0.0.0/8',
        );
        if (value === null) return;
        update({
            noProxy: value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0),
        });
    }, [draft?.noProxy, editText, update]);

    const manual = draft?.manual ?? EMPTY_MANUAL;
    const passwordLabel = status?.config.manual?.hasPassword
        ? t('settingsProxy.passwordSet')
        : t('settingsProxy.notSet');
    const bypassLabel = (draft?.noProxy ?? []).length > 0
        ? (draft?.noProxy ?? []).join(', ')
        : t('settingsProxy.notSet');
    const resolvedLabel = status?.proxyUrl
        ?? (status?.pacUrl ? t('settingsProxy.statusPac') : t('settingsProxy.statusDirect'));

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {choices.length > 1 && (
                <ItemGroup title={t('settingsProxy.machine')}>
                    {choices.map((choice) => (
                        <Item
                            key={choice.id}
                            title={choice.name}
                            subtitle={choice.online ? t('status.online') : t('status.offline')}
                            selected={choice.id === selected?.id}
                            showChevron={false}
                            onPress={() => setSelectedId(choice.id)}
                            rightElement={choice.id === selected?.id ? (
                                <Ionicons name="checkmark" size={20} color={theme.colors.header.tint} />
                            ) : undefined}
                        />
                    ))}
                </ItemGroup>
            )}

            {!draft ? (
                <ItemGroup>
                    <Item
                        title={choices.length === 0 ? t('settingsProxy.noMachines') : t('settingsProxy.offline')}
                        icon={<Ionicons name="cloud-offline-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                        disabled
                    />
                </ItemGroup>
            ) : (
                <>
                    <ItemGroup title={t('settingsProxy.mode')}>
                        {MODES.map((mode) => (
                            <Item
                                key={mode}
                                title={modeTitle(mode)}
                                selected={draft.mode === mode}
                                showChevron={false}
                                onPress={() => update({ mode })}
                                rightElement={draft.mode === mode ? (
                                    <Ionicons name="checkmark" size={20} color={theme.colors.header.tint} />
                                ) : undefined}
                            />
                        ))}
                    </ItemGroup>

                    {draft.mode === 'manual' && (
                        <>
                            <ItemGroup title={t('settingsProxy.protocol')}>
                                {PROTOCOLS.map((protocol) => (
                                    <Item
                                        key={protocol}
                                        title={protocol.toUpperCase()}
                                        selected={manual.protocol === protocol}
                                        showChevron={false}
                                        onPress={() => updateManual({ protocol })}
                                        rightElement={manual.protocol === protocol ? (
                                            <Ionicons name="checkmark" size={20} color={theme.colors.header.tint} />
                                        ) : undefined}
                                    />
                                ))}
                            </ItemGroup>
                            <ItemGroup>
                                <Item title={t('settingsProxy.host')} detail={manual.host || t('settingsProxy.notSet')} onPress={editHost} />
                                <Item title={t('settingsProxy.port')} detail={manual.port ? String(manual.port) : t('settingsProxy.notSet')} onPress={editPort} />
                                <Item title={t('settingsProxy.username')} detail={manual.username ?? t('settingsProxy.notSet')} onPress={editUsername} />
                                <Item title={t('settingsProxy.password')} detail={passwordLabel} onPress={editPassword} />
                            </ItemGroup>
                        </>
                    )}

                    {draft.mode === 'pac' && (
                        <ItemGroup>
                            <Item title={t('settingsProxy.pacUrl')} detail={draft.pacUrl ?? t('settingsProxy.notSet')} onPress={editPacUrl} />
                        </ItemGroup>
                    )}

                    <ItemGroup>
                        <Item title={t('settingsProxy.bypass')} detail={bypassLabel} onPress={editBypass} />
                        <Item
                            title={t('settingsProxy.childProcesses')}
                            showChevron={false}
                            rightElement={(
                                <Switch
                                    value={draft.useForChildProcesses}
                                    onValueChange={(value: boolean) => update({ useForChildProcesses: value })}
                                />
                            )}
                        />
                    </ItemGroup>

                    <ItemGroup>
                        <Item
                            title={t('settingsProxy.save')}
                            icon={<Ionicons name="save-outline" size={29} color={theme.colors.header.tint} />}
                            showChevron={false}
                            loading={saving}
                            disabled={saving}
                            onPress={save}
                        />
                        <Item
                            title={t('settingsProxy.reload')}
                            icon={<Ionicons name="refresh-outline" size={29} color="#FF9500" />}
                            showChevron={false}
                            loading={loading}
                            onPress={() => setReloadToken((token) => token + 1)}
                        />
                    </ItemGroup>

                    {status && (
                        <ItemGroup title={t('settingsProxy.status')}>
                            <Item title={t('settingsProxy.statusRelay')} detail={status.relayUrl} showChevron={false} />
                            <Item title={t('settingsProxy.statusProxy')} detail={resolvedLabel} showChevron={false} />
                            <Item
                                title={t('settingsProxy.statusAgent')}
                                detail={status.agentReady ? t('settingsProxy.statusReady') : t('settingsProxy.statusUnavailable')}
                                showChevron={false}
                            />
                        </ItemGroup>
                    )}
                </>
            )}
        </ItemList>
    );
});
