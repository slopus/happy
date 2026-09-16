import React, { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Avatar } from '@/components/Avatar';
import { useAuth } from '@/auth/AuthContext';
import { listSavedAccounts, type SavedAccount } from '@/auth/accounts';
import { getActiveAccountKey } from '@/auth/accountRuntime';
import { t } from '@/text';

export const SavedAccountsMenu = React.forwardRef<{ focus: () => void }, { onNavigate: (path: string) => void }>(function SavedAccountsMenu({ onNavigate }, ref) {
    const { switchAccount } = useAuth();
    const { theme } = useUnistyles();
    const [accounts, setAccounts] = useState<SavedAccount[]>([]);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);
    const [pending, setPending] = useState<string | null>(null);
    const [hovered, setHovered] = useState<string | null>(null);
    const inFlight = useRef(false);
    const mounted = useRef(true);
    const firstRow = useRef<any>(null);
    useImperativeHandle(ref, () => ({ focus: () => { firstRow.current?.focus?.(); } }), []);
    // Animated menus may mount after the parent's initial focus timer fires.
    // The menu-local load lifecycle owns initial focus, not that timer.
    useEffect(() => {
        if (loading) return;
        const timer = setTimeout(() => firstRow.current?.focus?.(), 0);
        return () => clearTimeout(timer);
    }, [loading]);
    const activeKey = getActiveAccountKey();
    useEffect(() => {
        mounted.current = true;
        listSavedAccounts().then(rows => { if (mounted.current) setAccounts(rows); })
            .catch(() => { if (mounted.current) setFailed(true); })
            .finally(() => { if (mounted.current) setLoading(false); });
        return () => { mounted.current = false; };
    }, []);
    const select = async (key: string) => {
        if (inFlight.current || key === activeKey) return;
        inFlight.current = true;
        setPending(key);
        setFailed(false);
        try { await switchAccount(key); }
        catch { if (mounted.current) setFailed(true); }
        finally { inFlight.current = false; if (mounted.current) setPending(null); }
    };
    return <View style={styles.group} testID="sidebar-saved-accounts">
        <Text style={styles.heading}>{t('accounts.switch')}</Text>
        {loading && <ActivityIndicator accessibilityLabel={t('common.loading')} color={theme.colors.textSecondary} />}
        <View>
            {accounts.map((account, index) => {
                const selected = account.key === activeKey;
                return <Pressable key={account.key} ref={index === 0 ? firstRow : undefined} accessibilityRole="button"
                    accessibilityLabel={account.label || account.accountId}
                    accessibilityState={{ selected, disabled: pending !== null, busy: pending === account.key }}
                    disabled={pending !== null} onPress={() => void select(account.key)}
                    onHoverIn={() => setHovered(account.key)} onHoverOut={() => setHovered(null)}
                    testID={`sidebar-switch-account-${account.accountId}`}
                    style={({ pressed }) => [styles.row, selected && styles.selected, (pressed || hovered === account.key) && styles.hover]}>
                    <Avatar id={account.accountId} size={30} />
                    <View style={styles.identity}>
                        <Text numberOfLines={1} style={styles.name}>{account.label || account.accountId}</Text>
                        <Text numberOfLines={1} style={styles.server}>{account.serverUrl.replace(/^https?:\/\//, '')}</Text>
                    </View>
                    {pending === account.key ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : selected ?
                        <Ionicons name="checkmark-circle" size={18} color={theme.colors.text} accessibilityLabel={t('accounts.active')} /> : null}
                </Pressable>;
            })}
        </View>
        {failed && <Text accessibilityRole="alert" style={styles.error}>{t('accounts.failed')}</Text>}
        <Pressable ref={accounts.length === 0 ? firstRow : undefined} accessibilityRole="button" disabled={pending !== null} onPress={() => onNavigate('/accounts?add=1')}
            style={({ pressed }) => [styles.row, pressed && styles.hover]} testID="sidebar-add-account">
            <Ionicons name="add-circle-outline" size={26} color={theme.colors.textSecondary} />
            <Text style={styles.name}>{t('accounts.add')}</Text>
        </Pressable>
    </View>;
});

const styles = StyleSheet.create(theme => ({
    group: { padding: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider },
    heading: { color: theme.colors.textSecondary, fontSize: 11, paddingHorizontal: 8, paddingVertical: 6 },
    row: { minHeight: 48, paddingHorizontal: 8, paddingVertical: 7, borderRadius: 9, flexDirection: 'row', alignItems: 'center', gap: 9 },
    identity: { flex: 1, minWidth: 0 },
    name: { color: theme.colors.text, fontSize: 13, fontWeight: '600' },
    server: { color: theme.colors.textSecondary, fontSize: 11, marginTop: 2 },
    selected: { backgroundColor: theme.colors.surfaceSelected },
    hover: { backgroundColor: theme.colors.surfacePressed },
    error: { color: theme.colors.status.error, fontSize: 12, padding: 8 },
}));
