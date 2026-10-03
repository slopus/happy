import * as React from 'react';
import { Modal, Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { isAppGrantActive, type AppAuthorizationGrant } from '@/sync/apiAppDelegation';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Item } from './Item';

const formatDate = (value: string) => new Date(value).toLocaleString([], {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

export const AppConnectionsMenu = React.memo((props: {
    app: { name: string; origin: string | null };
    anchor: { x: number; y: number };
    grants: AppAuthorizationGrant[];
    deviceName: (id: string | null) => string;
    busy: boolean;
    onClose: () => void;
    onOpenApp: () => void;
    onChangeGrant: (grant: AppAuthorizationGrant, remove: boolean) => void;
}) => {
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const mobile = Platform.OS !== 'web' || width < 768;
    const [expanded, setExpanded] = React.useState<string | null>(null);
    const closeButton = React.useRef<any>(null);
    const menuWidth = Math.min(mobile ? 560 : 380, width - (mobile ? 0 : 24));
    const maxHeight = Math.min(mobile ? height - insets.top - 24 : 600, height - 48);
    const frame = mobile ? { width: menuWidth, maxHeight, paddingBottom: Math.max(insets.bottom, 12) } : {
        width: menuWidth, maxHeight,
        left: Math.max(12, Math.min(width - menuWidth - 12, props.anchor.x - menuWidth)),
        top: Math.max(24, Math.min(height - maxHeight - 24, props.anchor.y + 8)),
    };

    return <Modal transparent visible animationType={mobile ? 'slide' : 'none'}
        statusBarTranslucent navigationBarTranslucent onRequestClose={props.onClose}
        onShow={() => { if (Platform.OS === 'web') closeButton.current?.focus?.(); }}>
        <View style={[styles.root, mobile && styles.mobileRoot]}>
            <Pressable style={styles.backdrop} onPress={props.onClose} accessible={false} testID="app-connections-backdrop" />
            <View style={[styles.menu, mobile ? styles.sheet : styles.popover, frame]} testID="app-conversations-group-menu">
                {mobile ? <View style={styles.handle} /> : null}
                <View style={styles.header}>
                    <View style={styles.appIcon}><Ionicons name="apps-outline" size={24} color={theme.colors.text} /></View>
                    <View style={styles.appIdentity}>
                        <Text style={styles.heading}>{props.app.name}</Text>
                        <Text style={styles.secondary}>{t('appAuthorization.chatOnly')}</Text>
                    </View>
                    <Pressable ref={closeButton} accessibilityRole="button" accessibilityLabel={t('sidebarLists.close')}
                        onPress={props.onClose} style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
                        <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                    </Pressable>
                </View>
                <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
                    {props.app.origin ? <View style={styles.card}>
                        <Item title={t('appConversations.openApp')} subtitle={props.app.origin.replace(/^https?:\/\//, '')}
                            icon={<Ionicons name="open-outline" size={20} color={theme.colors.textSecondary} />}
                            onPress={props.onOpenApp} style={styles.item} titleStyle={styles.itemTitle} subtitleStyle={styles.secondary}
                            showDivider={false} testID="app-connections-open-app" />
                    </View> : null}
                    <Text style={styles.sectionTitle}>{t('appConversations.manage')} · {props.grants.length}</Text>
                    {props.grants.map(grant => {
                        const active = isAppGrantActive(grant);
                        const expiry = grant.expiresAt === null ? t('appConversations.permanent')
                            : t('appAuthorization.expiresAt', { date: formatDate(grant.expiresAt) });
                        const status = grant.state === 'revoked' ? t('appConversations.revoked') : t('appConversations.expired');
                        const open = expanded === grant.id;
                        return <View key={grant.id} style={styles.card} testID={`app-connection-${grant.id}`}>
                            <Item title={props.deviceName(grant.machineId)} subtitle={active ? expiry : status}
                                subtitleLines={2} icon={<Ionicons name="laptop-outline" size={22} color={theme.colors.textSecondary} />}
                                rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={theme.colors.textSecondary} />}
                                onPress={() => setExpanded(open ? null : grant.id)} accessibilityState={{ expanded: open }}
                                style={styles.item} titleStyle={styles.itemTitle} subtitleStyle={styles.secondary}
                                pressableStyle={open ? styles.selected : undefined} showDivider={false}
                                testID={`app-connection-toggle-${grant.id}`} />
                            {open ? <View style={styles.details}>
                                <Text style={styles.connectionDate}>{t('appConversations.connection')} · {formatDate(grant.createdAt)}</Text>
                                {active ? <Item title={t('appConversations.revoke')} disabled={props.busy}
                                    icon={<Ionicons name="unlink-outline" size={18} color={theme.colors.textSecondary} />}
                                    onPress={() => props.onChangeGrant(grant, false)} showChevron={false} showDivider={false}
                                    style={styles.action} titleStyle={styles.itemTitle} testID={`app-connection-revoke-${grant.id}`} /> : null}
                                <Item title={t('appConversations.remove')} disabled={props.busy} destructive
                                    icon={<Ionicons name="trash-outline" size={18} color={theme.colors.textDestructive} />}
                                    onPress={() => props.onChangeGrant(grant, true)} showChevron={false} showDivider={false}
                                    style={styles.action} titleStyle={styles.itemTitle} testID={`app-connection-remove-${grant.id}`} />
                            </View> : null}
                        </View>;
                    })}
                </ScrollView>
            </View>
        </View>
    </Modal>;
});

const styles = StyleSheet.create(theme => ({
    root: { flex: 1 },
    mobileRoot: { justifyContent: 'flex-end', alignItems: 'center' },
    backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: theme.colors.modal.backdrop },
    menu: { backgroundColor: theme.colors.groupped.background, overflow: 'hidden', borderColor: theme.colors.divider },
    sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24 },
    popover: { position: 'absolute', borderWidth: StyleSheet.hairlineWidth, borderRadius: 18 },
    handle: { width: 32, height: 4, borderRadius: 2, backgroundColor: theme.colors.divider, alignSelf: 'center', marginTop: 10 },
    header: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 },
    appIcon: { width: 44, height: 44, borderRadius: 13, backgroundColor: theme.colors.surface, alignItems: 'center', justifyContent: 'center' },
    appIdentity: { flex: 1, gap: 3 },
    heading: { color: theme.colors.text, fontSize: 17, ...Typography.default('semiBold') },
    secondary: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18, ...Typography.default() },
    close: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    selected: { backgroundColor: theme.colors.surfaceSelected },
    scroll: { flexGrow: 0, flexShrink: 1 },
    content: { paddingHorizontal: 16, paddingBottom: 16, gap: 10 },
    sectionTitle: { fontSize: 12, color: theme.colors.textSecondary, paddingTop: 8, paddingHorizontal: 4, ...Typography.default('semiBold') },
    card: { backgroundColor: theme.colors.surface, borderRadius: 14, overflow: 'hidden' },
    item: { minHeight: 64, paddingHorizontal: 14, paddingVertical: 12 },
    itemTitle: { fontSize: 14, lineHeight: 20, ...Typography.default() },
    details: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider },
    connectionDate: { fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6 },
    action: { minHeight: 44, paddingHorizontal: 14, paddingVertical: 10 },
}));
