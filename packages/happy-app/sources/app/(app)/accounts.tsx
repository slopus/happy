import React, { useEffect, useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { addSavedAccount, listSavedAccounts, removeSavedAccount, type SavedAccount } from '@/auth/accounts';
import { canonicalAccountServer, getActiveAccountKey } from '@/auth/accountRuntime';
import { getServerUrl } from '@/sync/serverConfig';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { layout } from '@/components/layout';
import { Modal } from '@/modal';
import { t } from '@/text';
import { parseAccountSessionTarget } from '@/auth/accountLink';
import { AccountVault } from '@/auth/tokenStorage';
import { formatSecretKeyForBackup } from '@/auth/secretKeyBackup';
import Animated, { FadeIn, FadeOut, LinearTransition, ReduceMotion } from 'react-native-reanimated';

export default React.memo(function AccountsPage() {
    const auth = useAuth();
    const { theme } = useUnistyles();
    const params = useLocalSearchParams<{ accountId?: string; serverUrl?: string; sessionId?: string; add?: string; accountKey?: string }>();
    const [adding, setAdding] = useState(params.add === '1');
    useEffect(() => { if (params.add === '1') setAdding(true); }, [params.add]);
    const hasTarget = params.accountId !== undefined || params.serverUrl !== undefined || params.sessionId !== undefined;
    const target = parseAccountSessionTarget(params);
    const [accounts, setAccounts] = useState<SavedAccount[]>([]);
    const [secret, setSecret] = useState('');
    const [label, setLabel] = useState('');
    const [serverUrl, setServerUrl] = useState(target?.serverUrl ?? getServerUrl());
    const [busy, setBusy] = useState(false);
    const actionInFlight = useRef(false);
    const [failed, setFailed] = useState(false);
    const [detailSecret, setDetailSecret] = useState<string | null>(null);
    const [showDetailSecret, setShowDetailSecret] = useState(false);
    const activeKey = getActiveAccountKey();
    const reload = async () => setAccounts(await listSavedAccounts());
    useEffect(() => { reload().catch(() => setFailed(true)); }, []);
    const run = async (action: () => Promise<void>) => {
        if (actionInFlight.current) return;
        actionInFlight.current = true;
        setBusy(true);
        setFailed(false);
        try { await action(); } catch { setFailed(true); } finally { actionInFlight.current = false; setBusy(false); }
    };
    const matches = (account: SavedAccount) => !target || (account.accountId === target.accountId && canonicalAccountServer(account.serverUrl) === target.serverUrl);
    const detailAccount = params.accountKey ? accounts.find(account => account.key === params.accountKey) : undefined;
    useEffect(() => {
        setShowDetailSecret(false);
        setDetailSecret(null);
        if (!detailAccount) return;
        AccountVault.read(detailAccount.key)
            .then(credentials => setDetailSecret(credentials?.secret ?? null))
            .catch(() => setDetailSecret(null));
    }, [detailAccount]);

    if (params.accountKey) {
        return <ItemList>
            {detailAccount ? <>
                <ItemGroup title={detailAccount.label || detailAccount.accountId}>
                    <Item title={t('settingsAccount.status')} detail={detailAccount.key === activeKey ? t('accounts.active') : undefined} showChevron={false} />
                    <Item title={t('settingsAccount.publicId')} detail={detailAccount.accountId} showChevron={false} copy />
                    <Item title={t('accounts.server')} detail={detailAccount.serverUrl} showChevron={false} copy />
                </ItemGroup>
                <ItemGroup title={t('settingsAccount.secretKey')} footer={t('accounts.secretHint')}>
                    <Item
                        title={t('settingsAccount.secretKey')}
                        subtitle={showDetailSecret && detailSecret ? formatSecretKeyForBackup(detailSecret) : t('settingsAccount.tapToReveal')}
                        onPress={() => setShowDetailSecret(current => !current)}
                    />
                </ItemGroup>
            </> : <ItemGroup><Item title={t('accounts.invalidLink')} showChevron={false} /></ItemGroup>}
        </ItemList>;
    }

    return <ItemList>
        {hasTarget && <ItemGroup title={t('accounts.target')} footer={t('accounts.targetHint')}>
            <Item title={target ? target.accountId : t('accounts.invalidLink')} subtitle={target?.serverUrl} showChevron={false} />
        </ItemGroup>}
        <ItemGroup title={t('accounts.title')}>
            {accounts.length === 0 && <Item title={t('accounts.empty')} showChevron={false} />}
            {accounts.map(account => <View key={account.key}>
                <Item title={account.label || account.accountId} subtitle={`${account.serverUrl}\n${account.accountId}`}
                    detail={activeKey === account.key ? t('accounts.active') : undefined}
                    disabled={busy || (hasTarget && (!target || !matches(account)))}
                    onPress={() => {
                        if (hasTarget) {
                            void run(() => auth.switchAccount(account.key, target && matches(account) ? target.sessionId : undefined));
                            return;
                        }
                        router.push({ pathname: '/accounts', params: { accountKey: account.key } } as any);
                    }} />
                {activeKey !== account.key && <Item title={t('accounts.remove')} disabled={busy} onPress={() => void run(async () => {
                    if (await Modal.confirm(t('accounts.remove'), t('accounts.removeHint'), { destructive: true, confirmText: t('accounts.remove') })) {
                        await removeSavedAccount(account.key);
                        await reload();
                    }
                })} />}
            </View>)}
        </ItemGroup>
        <Animated.View layout={LinearTransition.duration(220).reduceMotion(ReduceMotion.System)}>
        {!adding ? <ItemGroup><Item title={t('accounts.add')} onPress={() => setAdding(true)} /></ItemGroup> :
        <Animated.View entering={FadeIn.duration(180).reduceMotion(ReduceMotion.System)} exiting={FadeOut.duration(140).reduceMotion(ReduceMotion.System)}>
        <ItemGroup title={t('accounts.add')} footer={t('accounts.secretHint')}>
            <View style={styles.form}>
                <Text style={styles.label}>{t('accounts.server')}</Text>
                <TextInput style={styles.input} value={serverUrl} onChangeText={setServerUrl} editable={!busy && !target} autoCapitalize="none" autoCorrect={false} accessibilityLabel={t('accounts.server')} placeholderTextColor={theme.colors.textSecondary} />
                <Text style={styles.label}>{t('accounts.label')}</Text>
                <TextInput style={styles.input} value={label} onChangeText={setLabel} maxLength={80} editable={!busy} accessibilityLabel={t('accounts.label')} />
                <Text style={styles.label}>{t('accounts.secret')}</Text>
                <TextInput style={styles.input} value={secret} onChangeText={setSecret} secureTextEntry autoCapitalize="none" autoCorrect={false} editable={!busy} accessibilityLabel={t('accounts.secret')} />
            </View>
            <Item title={t('accounts.add')} loading={busy} disabled={!secret.trim() || (hasTarget && !target)} onPress={() => void run(async () => {
                if (target && canonicalAccountServer(serverUrl) !== target.serverUrl) throw new Error('account_target_mismatch');
                await addSavedAccount({ secret: secret.trim(), serverUrl, label: label.trim() || undefined, expectedAccountId: target?.accountId });
                setSecret('');
                setLabel('');
                await reload();
                setAdding(false);
            })} />
            <Item title={t('common.cancel')} disabled={busy} onPress={() => { setSecret(''); setLabel(''); setAdding(false); }} />
        </ItemGroup>
        </Animated.View>}
        </Animated.View>
        {failed && <ItemGroup footer={t('accounts.failed')}><Item title={t('accounts.retry')} disabled={busy} onPress={() => void run(reload)} /></ItemGroup>}
    </ItemList>;
});

const styles = StyleSheet.create(theme => ({
    form: { width: '100%', maxWidth: layout.maxWidth, alignSelf: 'center', padding: 16, gap: 10 },
    label: { color: theme.colors.text, fontSize: 14 },
    input: { color: theme.colors.text, backgroundColor: theme.colors.surfaceSelected, borderRadius: 8, padding: 12, fontSize: 16 },
}));
