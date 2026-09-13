import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import type { CodexAccountsController } from '@/hooks/useCodexAccounts';
import type { CodexAccountProfile, CodexAccountErrorCode } from '@/sync/apiCodexAccounts';
import { Modal } from '@/modal';
import { t } from '@/text';

const UPLOAD_COMMAND = 'paws codex account upload';
type Machine = { id: string; name: string; active?: boolean };
const statusText = (status: CodexAccountProfile['status']) => t(status === 'available' ? 'codexAccounts.available' : status === 'invalid' ? 'codexAccounts.invalid' : 'codexAccounts.needsRefresh');
function errorText(code: CodexAccountErrorCode): string {
    switch (code) {
        case 'binding-version-conflict': return t('codexAccounts.bindingConflict');
        case 'display-name-conflict': return t('codexAccounts.nameConflict');
        case 'profile-not-found': return t('codexAccounts.removed');
        case 'codex-account-unavailable': return t('codexAccounts.reupload');
        case 'authentication-required': return t('codexAccounts.signIn');
        case 'https-required': return t('codexAccounts.httpsRequired');
        case 'invalid-response': return t('codexAccounts.serverUpdate');
        case 'network-error': return t('codexAccounts.networkError');
        default: return t('codexAccounts.operationFailed');
    }
}

function AccountButton({ children, testID, label, disabled, selected, onPress, radio = false }: {
    children: React.ReactNode; testID: string; label: string; disabled?: boolean; selected?: boolean; radio?: boolean; onPress(): void;
}) {
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    return <Pressable testID={testID} accessibilityRole={radio ? 'radio' : 'button'} accessibilityLabel={label}
        accessibilityState={{ disabled: Boolean(disabled), ...(radio ? { checked: Boolean(selected) } : {}) }} disabled={disabled} onPress={onPress}
        onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={({ pressed }) => [styles.button, selected && styles.selected, !disabled && (pressed || hovered) && styles.pressed, focused && styles.focused, disabled && styles.disabled]}>
        {children}
    </Pressable>;
}

function Quota({ profile }: { profile: CodexAccountProfile }) {
    const [deadlineVersion, setDeadlineVersion] = React.useState(0);
    const now = Date.now();
    const quota = profile.quota;
    const resetsAt = quota.weeklyResetsAt ? Date.parse(quota.weeklyResetsAt) : null;
    const staleAt = quota.observedAt ? Date.parse(quota.observedAt) + 24 * 60 * 60 * 1000 : null;
    // Local display deadlines only: no network or provider quota requests.
    React.useEffect(() => {
        const time = Date.now();
        const next = [resetsAt, staleAt].filter((value): value is number => value !== null && value > time).sort((a, b) => a - b)[0];
        if (next === undefined) return;
        const timer = setTimeout(() => setDeadlineVersion(value => value + 1), next - time + 1);
        return () => clearTimeout(timer);
    }, [resetsAt, staleAt, deadlineVersion]);
    const reset = quota.state === 'reset' || (resetsAt !== null && resetsAt <= now);
    const unknown = reset || quota.state === 'unknown' || quota.remainingPercent === null;
    const stale = quota.state === 'stale' || (staleAt !== null && staleAt <= now);
    return <Text style={styles.secondary}>
        {unknown ? t('codexAccounts.quotaUnknown') : t('codexAccounts.quotaRemaining', { percent: Math.round(quota.remainingPercent!) })}
        {reset ? ` · ${t('codexAccounts.quotaWaiting')}` : !unknown && resetsAt !== null ? ` · ${t('codexAccounts.quotaReset', {
            time: new Date(resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
        })}` : ''}
        {!unknown && stale ? ` · ${t('codexAccounts.quotaStale')}` : ''}
    </Text>;
}

export function CodexAccountSection({ controller, machines }: { controller: CodexAccountsController; machines: Machine[] }) {
    const [copy, setCopy] = React.useState<'idle' | 'copied' | 'failed'>('idle');
    const [confirming, setConfirming] = React.useState(false);
    React.useEffect(() => { if (copy === 'idle') return; const timer = setTimeout(() => setCopy('idle'), 1800); return () => clearTimeout(timer); }, [copy]);
    const disabled = controller.busy || controller.loading || confirming;
    const copyLabel = copy === 'copied' ? t('common.copied') : copy === 'failed' ? t('codexAccounts.copyFailed') : t('common.copy');
    async function rename(profile: CodexAccountProfile) {
        setConfirming(true);
        try {
            const name = await Modal.prompt(t('codexAccounts.rename'), t('codexAccounts.nameHint'), {
                defaultValue: profile.displayName, confirmText: t('common.save'), cancelText: t('common.cancel'),
            });
            if (name?.trim() && name.trim() !== profile.displayName) await controller.rename(profile.id, name.trim());
        } finally { setConfirming(false); }
    }
    async function remove(profile: CodexAccountProfile) {
        setConfirming(true);
        try {
            const affected = controller.bindings.filter(b => b.profileId === profile.id)
                .map(b => machines.find(m => m.id === b.machineId)?.name ?? b.machineId);
            const approved = await Modal.confirm(t('codexAccounts.delete'), t('codexAccounts.deleteConfirm', {
                name: profile.displayName, devices: affected.length ? affected.join(', ') : t('codexAccounts.noBindings'),
            }), { destructive: true, confirmText: t('common.delete'), cancelText: t('common.cancel') });
            if (approved) await controller.remove(profile.id);
        } finally { setConfirming(false); }
    }
    async function refresh(profile: CodexAccountProfile) {
        const machine = machines.find(candidate => candidate.active !== false && controller.bindings.some(binding => binding.machineId === candidate.id && binding.profileId === profile.id));
        if (!machine) return;
        const approved = await Modal.confirm(t('codexAccounts.refreshQuotaConfirmTitle'), t('codexAccounts.refreshQuotaConfirm'), {
            confirmText: t('codexAccounts.refreshQuota'), cancelText: t('common.cancel'),
        });
        if (approved) await controller.refresh(profile.id, machine.id);
    }
    return <View style={styles.section} testID="codex-account-section">
        <Text accessibilityRole="header" style={styles.title}>{t('codexAccounts.title')}</Text>
        <Text style={styles.secondary}>{t('codexAccounts.description')}</Text>
        <View style={styles.commandRow}>
            <Text selectable style={styles.command}>{UPLOAD_COMMAND}</Text>
            <AccountButton testID="codex-account-copy" label={copyLabel} onPress={() => { void (async () => {
                try { await Clipboard.setStringAsync(UPLOAD_COMMAND); setCopy('copied'); } catch { setCopy('failed'); }
            })(); }}><Text accessibilityLiveRegion="polite" style={styles.link}>{copyLabel}</Text></AccountButton>
        </View>
        {controller.error ? <Text accessibilityRole="alert" style={styles.error}>{errorText(controller.error)}</Text> : null}
        {controller.migration === 'needs-upload' ? <Text style={styles.error}>{t('codexAccounts.reupload')}</Text> : null}
        {controller.loading ? <Text style={styles.secondary}>{t('common.loading')}</Text> : !controller.profiles.length ? <Text style={styles.secondary}>{t('codexAccounts.empty')}</Text> : null}
        <View style={styles.cards} testID="codex-account-cards">{controller.profiles.map(profile => <View key={profile.id} style={styles.card} testID={`codex-account-${profile.id}`}>
            <Text numberOfLines={2} style={styles.title}>{profile.displayName}</Text>
            <Text style={profile.status === 'available' ? styles.available : styles.error}>{statusText(profile.status)}</Text>
            <Quota profile={profile} />
            <Text style={styles.secondary}>{t('codexAccounts.updated', { time: new Date(profile.updatedAt).toLocaleString() })}</Text>
            <View style={styles.actions}>
                {(() => {
                    const refreshable = machines.some(machine => machine.active !== false && controller.bindings.some(binding => binding.machineId === machine.id && binding.profileId === profile.id));
                    return <AccountButton testID={`codex-account-refresh-${profile.id}`} label={`${t('codexAccounts.refreshQuota')} · ${profile.displayName}`}
                        disabled={disabled || !refreshable || profile.status !== 'available'} onPress={() => { void refresh(profile); }}>
                        <Text style={styles.link}>{controller.busy ? t('codexAccounts.refreshingQuota') : t('codexAccounts.refreshQuota')}</Text>
                    </AccountButton>;
                })()}
                <AccountButton testID={`codex-account-rename-${profile.id}`} label={`${t('codexAccounts.rename')} · ${profile.displayName}`} disabled={disabled} onPress={() => { void rename(profile); }}><Text style={styles.link}>{t('codexAccounts.rename')}</Text></AccountButton>
                <AccountButton testID={`codex-account-delete-${profile.id}`} label={`${t('codexAccounts.delete')} · ${profile.displayName}`} disabled={disabled} onPress={() => { void remove(profile); }}><Text style={styles.destructive}>{t('codexAccounts.delete')}</Text></AccountButton>
            </View>
        </View>)}</View>
        <Text style={styles.secondary}>{t('codexAccounts.passiveHint')}</Text>
    </View>;
}

export function CodexAccountBindingCell({ controller, machine, width }: { controller: CodexAccountsController; machine: Machine; width: number }) {
    const binding = controller.bindings.find(b => b.machineId === machine.id);
    const profile = controller.profiles.find(p => p.id === binding?.profileId);
    const [menuVersion, setMenuVersion] = React.useState<number | null>(null);
    const name = profile?.displayName ?? t(binding?.profileId ? 'codexAccounts.removed' : 'codexAccounts.unbound');
    const disabled = controller.loading || controller.busy || !binding;
    return <View style={[styles.bindingCell, { width }]} testID={`codex-binding-cell-${machine.id}`}>
        <AccountButton testID={`codex-binding-${machine.id}`} label={`${machine.name} · ${t('codexAccounts.defaultAccount')} · ${name}`} disabled={disabled}
            onPress={() => setMenuVersion(menuVersion === null ? binding!.version : null)}>
            <Text numberOfLines={1} style={styles.bindingName}>{name} ▾</Text>
            <Text numberOfLines={1} style={profile && profile.status !== 'available' ? styles.error : styles.secondary}>
                {profile ? statusText(profile.status) : t(binding ? 'codexAccounts.bindingRequired' : 'codexAccounts.bindingUnknown')}
            </Text>
        </AccountButton>
        {menuVersion !== null ? <View style={styles.menu} testID={`codex-binding-menu-${machine.id}`}>
            <Text style={styles.secondary}>{machine.name} · {t('codexAccounts.nextProcess')}</Text>
            <ScrollView style={styles.options} nestedScrollEnabled accessibilityRole="radiogroup" accessibilityLabel={`${machine.name} · ${t('codexAccounts.defaultAccount')}`}>
                {[null, ...controller.profiles].map(option => {
                    const optionId = option?.id ?? null;
                    const optionName = option?.displayName ?? t('codexAccounts.unbound');
                    return <AccountButton key={optionId ?? 'unbound'} testID={`codex-binding-option-${machine.id}-${optionId ?? 'unbound'}`} label={optionName}
                        radio selected={binding?.profileId === optionId} disabled={disabled || Boolean(option && option.status !== 'available')}
                        onPress={() => { const version = menuVersion; setMenuVersion(null); if (binding?.profileId !== optionId) void controller.bind(machine.id, optionId, version); }}>
                        <Text numberOfLines={2} style={styles.bindingName}>{optionName}</Text>
                        {option ? <Text style={styles.secondary}>{statusText(option.status)}</Text> : null}
                    </AccountButton>;
                })}
            </ScrollView>
            <AccountButton testID={`codex-binding-close-${machine.id}`} label={t('common.cancel')} onPress={() => setMenuVersion(null)}><Text style={styles.link}>{t('common.cancel')}</Text></AccountButton>
        </View> : null}
    </View>;
}

const styles = StyleSheet.create(theme => ({
    section: { gap: 10, paddingVertical: 16, minWidth: 0, maxWidth: '100%' },
    title: { color: theme.colors.text, fontSize: 14, lineHeight: 20, ...Typography.default('semiBold') },
    secondary: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18, ...Typography.default() },
    available: { color: theme.colors.status.connected, fontSize: 12, lineHeight: 18 },
    error: { color: theme.colors.status.error, fontSize: 12, lineHeight: 18 },
    destructive: { color: theme.colors.textDestructive, fontSize: 12, lineHeight: 18 },
    commandRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0 },
    command: { color: theme.colors.text, backgroundColor: theme.colors.surfaceHigh, padding: 10, borderRadius: 6, flexShrink: 1, fontSize: 12, ...Typography.mono() },
    cards: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, minWidth: 0 },
    card: { flexGrow: 1, flexShrink: 1, flexBasis: 250, minWidth: 0, maxWidth: '100%', gap: 6, padding: 12, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    button: { minHeight: 40, minWidth: 0, maxWidth: '100%', paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6, justifyContent: 'center', backgroundColor: theme.colors.surface },
    link: { color: theme.colors.textLink, fontSize: 12, lineHeight: 18, ...Typography.default('semiBold') },
    pressed: { backgroundColor: theme.colors.surfacePressed }, selected: { backgroundColor: theme.colors.surfaceSelected },
    focused: { backgroundColor: theme.colors.surfaceSelected, outlineWidth: 1, outlineColor: theme.colors.textLink }, disabled: { opacity: 0.5 },
    bindingCell: { height: 88, padding: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    bindingName: { color: theme.colors.text, fontSize: 13, lineHeight: 19, ...Typography.default() },
    menu: { position: 'absolute', top: 76, left: 4, right: 4, zIndex: 10, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 8, padding: 6, gap: 4 },
    options: { maxHeight: 220 },
}));
