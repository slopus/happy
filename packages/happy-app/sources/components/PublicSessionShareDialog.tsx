import * as React from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { StyleSheet } from 'react-native-unistyles';
import { usePublicSessionShare } from '@/hooks/usePublicSessionShare';
import { t } from '@/text';

export interface PublicSessionShareDialogProps {
    sessionId: string;
    title: string;
    onClose?: () => void;
}

export const PublicSessionShareDialog = React.memo(function PublicSessionShareDialog({
    sessionId,
    title,
    onClose,
}: PublicSessionShareDialogProps) {
    const {
        shareState,
        shareUrl,
        checking,
        progress,
        publishing,
        revoking,
        publish,
        revoke,
    } = usePublicSessionShare(sessionId, title);
    const [copied, setCopied] = React.useState(false);
    const [confirmingRevoke, setConfirmingRevoke] = React.useState(false);
    const wasPublishing = React.useRef(false);

    const copyLink = React.useCallback(async () => {
        if (!shareUrl) return;
        await Clipboard.setStringAsync(shareUrl);
        setCopied(true);
    }, [shareUrl]);

    React.useEffect(() => {
        if (publishing) {
            wasPublishing.current = true;
            setCopied(false);
            return;
        }
        if (wasPublishing.current && shareState.active && shareUrl) {
            wasPublishing.current = false;
            void copyLink();
        }
    }, [copyLink, publishing, shareState.active, shareUrl]);

    const openSharedPage = React.useCallback(() => {
        if (shareUrl) void Linking.openURL(shareUrl);
    }, [shareUrl]);

    const confirmRevoke = React.useCallback(() => {
        setConfirmingRevoke(false);
        revoke();
    }, [revoke]);

    const busy = publishing || revoking;
    const busyLabel = publishing
        ? progress.total > 0
            ? t('sessionShare.uploading', progress)
            : t('sessionShare.preparing')
        : t('sessionShare.revokeSharing');

    return (
        <View style={styles.dialog} testID="public-session-share-dialog">
            <View style={styles.header}>
                <View style={styles.titleRow}>
                    <View style={styles.iconWrap}>
                        <Ionicons name="share-social-outline" size={20} color={styles.icon.color} />
                    </View>
                    <View style={styles.titleCopy}>
                        <Text style={styles.title}>
                            {shareState.active ? t('sessionShare.manageSharing') : t('sessionShare.confirmTitle')}
                        </Text>
                        <Text style={styles.sessionTitle} numberOfLines={1}>{title}</Text>
                    </View>
                </View>
                <Pressable
                    accessibilityLabel={t('common.cancel')}
                    accessibilityRole="button"
                    onPress={onClose}
                    style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
                    testID="public-session-share-close"
                >
                    <Ionicons name="close" size={20} color={styles.closeIcon.color} />
                </Pressable>
            </View>

            {checking ? (
                <View style={styles.checking} testID="public-session-share-checking">
                    <ActivityIndicator size="small" color={styles.icon.color} />
                </View>
            ) : shareState.active && shareUrl && confirmingRevoke ? (
                <View style={styles.body} testID="public-session-share-revoke-confirmation">
                    <View style={styles.notice}>
                        <Ionicons name="warning-outline" size={20} color={styles.warningIcon.color} />
                        <View style={styles.confirmCopy}>
                            <Text style={styles.confirmTitle}>{t('sessionShare.revokeTitle')}</Text>
                            <Text style={styles.confirmMessage}>{t('sessionShare.revokeMessage')}</Text>
                        </View>
                    </View>
                    <View style={styles.footerActions}>
                        <Pressable
                            accessibilityLabel={t('common.cancel')}
                            accessibilityRole="button"
                            onPress={() => setConfirmingRevoke(false)}
                            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                            testID="public-session-share-revoke-cancel"
                        >
                            <Text style={styles.secondaryButtonText}>{t('common.cancel')}</Text>
                        </Pressable>
                        <Pressable
                            accessibilityLabel={t('sessionShare.revokeAction')}
                            accessibilityRole="button"
                            onPress={confirmRevoke}
                            style={({ pressed }) => [styles.destructiveButton, pressed && styles.destructiveButtonPressed]}
                            testID="public-session-share-revoke-confirm"
                        >
                            <Text style={styles.destructiveButtonText}>{t('sessionShare.revokeAction')}</Text>
                        </Pressable>
                    </View>
                </View>
            ) : shareState.active && shareUrl ? (
                <View style={styles.body}>
                    <View style={styles.activeStatus}>
                        <Ionicons name="checkmark-circle" size={18} color={styles.activeStatusIcon.color} />
                        <View style={styles.statusCopy}>
                            <Text style={styles.activeStatusText}>{t('sessionShare.shared')}</Text>
                            {shareState.publishedAt ? (
                                <Text style={styles.statusDate}>
                                    {t('sessionShare.sharedOn', { date: new Date(shareState.publishedAt).toLocaleString() })}
                                </Text>
                            ) : null}
                        </View>
                    </View>

                    <View style={styles.linkBox}>
                        <Text style={styles.linkText} numberOfLines={1}>{shareUrl}</Text>
                        <Pressable
                            accessibilityLabel={t('sessionShare.copyLink')}
                            accessibilityRole="button"
                            disabled={busy}
                            onPress={copyLink}
                            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                            testID="public-session-share-copy"
                        >
                            <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={18} color={styles.icon.color} />
                        </Pressable>
                    </View>
                    {copied ? <Text style={styles.copiedText}>{t('sessionShare.linkCopied')}</Text> : null}

                    <View style={styles.actionGrid}>
                        <DialogButton
                            icon="open-outline"
                            label={t('sessionShare.openSharedPage')}
                            onPress={openSharedPage}
                            testID="public-session-share-open"
                        />
                        <DialogButton
                            disabled={busy}
                            icon="refresh-outline"
                            label={t('sessionShare.updateSnapshot')}
                            onPress={publish}
                            testID="public-session-share-update"
                        />
                    </View>
                    <Pressable
                        accessibilityLabel={t('sessionShare.revokeSharing')}
                        accessibilityRole="button"
                        disabled={busy}
                        onPress={() => setConfirmingRevoke(true)}
                        style={({ pressed }) => [styles.revokeButton, pressed && styles.pressed, busy && styles.disabled]}
                        testID="public-session-share-revoke"
                    >
                        <Ionicons name="link-outline" size={17} color={styles.revokeText.color} />
                        <Text style={styles.revokeText}>{t('sessionShare.revokeSharing')}</Text>
                    </Pressable>
                </View>
            ) : (
                <View style={styles.body}>
                    <View style={styles.notice} testID="public-session-share-privacy-message">
                        <Ionicons name="globe-outline" size={20} color={styles.noticeIcon.color} />
                        <Text style={styles.noticeText}>{t('sessionShare.confirmMessage')}</Text>
                    </View>
                    <View style={styles.footerActions}>
                        <Pressable
                            accessibilityLabel={t('common.cancel')}
                            accessibilityRole="button"
                            disabled={busy}
                            onPress={onClose}
                            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                        >
                            <Text style={styles.secondaryButtonText}>{t('common.cancel')}</Text>
                        </Pressable>
                        <Pressable
                            accessibilityLabel={t('sessionShare.confirmAction')}
                            accessibilityRole="button"
                            disabled={busy}
                            onPress={publish}
                            style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, busy && styles.disabled]}
                            testID="public-session-share-create"
                        >
                            {publishing ? <ActivityIndicator size="small" color={styles.primaryButtonText.color} /> : null}
                            <Text style={styles.primaryButtonText} numberOfLines={1}>
                                {publishing ? busyLabel : t('sessionShare.confirmAction')}
                            </Text>
                        </Pressable>
                    </View>
                </View>
            )}

            {busy && shareState.active ? (
                <View style={styles.busyBar}>
                    <ActivityIndicator size="small" color={styles.icon.color} />
                    <Text style={styles.busyText}>{busyLabel}</Text>
                </View>
            ) : null}
        </View>
    );
});

function DialogButton({
    disabled,
    icon,
    label,
    onPress,
    testID,
}: {
    disabled?: boolean;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    label: string;
    onPress: () => void;
    testID: string;
}) {
    return (
        <Pressable
            accessibilityLabel={label}
            accessibilityRole="button"
            disabled={disabled}
            onPress={onPress}
            style={({ pressed }) => [styles.actionButton, pressed && styles.pressed, disabled && styles.disabled]}
            testID={testID}
        >
            <Ionicons name={icon} size={18} color={styles.icon.color} />
            <Text style={styles.actionButtonText}>{label}</Text>
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    dialog: {
        width: Platform.OS === 'web' ? 520 : '92%',
        maxWidth: '92%',
        alignSelf: 'center',
        borderRadius: 18,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: 20,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    titleRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
    iconWrap: {
        width: 38,
        height: 38,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHigh,
    },
    icon: { color: theme.colors.accent },
    closeIcon: { color: theme.colors.textSecondary },
    titleCopy: { flex: 1 },
    title: { color: theme.colors.text, fontSize: 18, fontWeight: '600' as const },
    sessionTitle: { color: theme.colors.textSecondary, fontSize: 13, marginTop: 3 },
    closeButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
    body: { padding: 20, gap: 16 },
    checking: { minHeight: 150, alignItems: 'center', justifyContent: 'center' },
    notice: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        padding: 16,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHigh,
    },
    noticeIcon: { color: theme.colors.accent },
    warningIcon: { color: theme.colors.status.error },
    noticeText: { flex: 1, color: theme.colors.text, fontSize: 14, lineHeight: 21 },
    confirmCopy: { flex: 1, gap: 5 },
    confirmTitle: { color: theme.colors.text, fontSize: 15, fontWeight: '600' as const },
    confirmMessage: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19 },
    activeStatus: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    activeStatusIcon: { color: theme.colors.status.connected },
    statusCopy: { flex: 1 },
    activeStatusText: { color: theme.colors.text, fontSize: 14, fontWeight: '600' as const },
    statusDate: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 },
    linkBox: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingLeft: 12,
        paddingRight: 6,
        paddingVertical: 6,
        borderRadius: 10,
        backgroundColor: theme.colors.surfaceHigh,
    },
    linkText: { flex: 1, color: theme.colors.textSecondary, fontSize: 13 },
    iconButton: { width: 36, height: 36, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
    copiedText: { color: theme.colors.status.connected, fontSize: 12, marginTop: -10 },
    actionGrid: { flexDirection: 'row', gap: 10 },
    actionButton: {
        flex: 1,
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        borderRadius: 10,
        backgroundColor: theme.colors.surfaceHigh,
    },
    actionButtonText: { color: theme.colors.text, fontSize: 14, fontWeight: '500' as const },
    revokeButton: {
        minHeight: 42,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        borderRadius: 10,
    },
    revokeText: { color: theme.colors.status.error, fontSize: 14, fontWeight: '500' as const },
    footerActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
    secondaryButton: {
        minWidth: 100,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 16,
        borderRadius: 10,
        backgroundColor: theme.colors.surfaceHigh,
    },
    secondaryButtonText: { color: theme.colors.text, fontSize: 14, fontWeight: '500' as const },
    primaryButton: {
        minWidth: 170,
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingHorizontal: 18,
        borderRadius: 10,
        backgroundColor: theme.colors.button.primary.background,
    },
    primaryButtonText: { color: theme.colors.button.primary.tint, fontSize: 14, fontWeight: '600' as const },
    destructiveButton: {
        minWidth: 140,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 18,
        borderRadius: 10,
        backgroundColor: theme.colors.button.destructive.background,
    },
    destructiveButtonPressed: { backgroundColor: theme.colors.button.destructive.backgroundPressed },
    destructiveButtonText: { color: theme.colors.button.destructive.tint, fontSize: 14, fontWeight: '600' as const },
    busyBar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingHorizontal: 20,
        paddingBottom: 18,
    },
    busyText: { color: theme.colors.textSecondary, fontSize: 13 },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    disabled: { opacity: 0.45 },
}));
