import * as React from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { canSendStagedMessageNow, type StagedMessage, type StagingSnapshot, type StagingSession } from '@/sync/messageStagingQueue';

export function MessageStagingQueueView(props: {
    messages: StagingSnapshot['messages'];
    session: StagingSession;
    onSteer: (id: string) => void;
    onRemove: (id: string) => void;
    onEdit: (message: StagedMessage) => void;
}) {
    const { theme } = useUnistyles();
    if (!props.messages.length) return null;
    const busy = props.session.state === 'running' || props.session.state === 'permission_required';
    const unavailableHint = busy && !props.session.supportsSteer ? t('messageQueue.steerUnavailable') : t('messageQueue.steerHint');
    const sendNowLabel = busy ? t('messageQueue.steerDuringTurn') : t('messageQueue.steer');
    const sending = props.messages.some(m => m.status === 'sending');
    return <View style={styles.container} testID="message-staging-queue">
        <Text style={styles.heading}>{t('messageQueue.title')} · {props.messages.length}</Text>
        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {props.messages.map(message => <View key={message.id} style={styles.row} testID={`queued-message-${message.id}`}>
                <View style={styles.content}>
                    <Text numberOfLines={2} style={styles.text}>{message.text || t('messageQueue.attachments')}</Text>
                    {!!message.attachments?.length && <Text style={styles.secondary}>{t('messageQueue.attachments')} · {message.attachments.length}</Text>}
                    {message.status === 'failed' && <Text style={styles.secondary}>{t('messageQueue.failed')}</Text>}
                </View>
                {message.status === 'sending' ? <ActivityIndicator accessibilityLabel={t('messageQueue.sending')} color={theme.colors.textSecondary} /> : <>
                    <Pressable accessibilityRole="button" accessibilityLabel={sendNowLabel} accessibilityHint={unavailableHint}
                        disabled={sending || !canSendStagedMessageNow(message, props.session)} onPress={() => props.onSteer(message.id)}
                        style={({ pressed }) => [styles.action, pressed && styles.pressed, (sending || !canSendStagedMessageNow(message, props.session)) && styles.disabled]}>
                        <Ionicons name="return-down-forward-outline" size={18} color={theme.colors.textSecondary} />
                        <Text style={styles.secondary}>{sendNowLabel}</Text>
                    </Pressable>
                    <Pressable accessibilityRole="button" accessibilityLabel={t('messageQueue.edit')} onPress={() => props.onEdit(message)} style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
                        <Ionicons name="create-outline" size={18} color={theme.colors.textSecondary} />
                    </Pressable>
                    <Pressable accessibilityRole="button" accessibilityLabel={t('common.delete')} onPress={() => props.onRemove(message.id)} style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
                        <Ionicons name="trash-outline" size={18} color={theme.colors.textSecondary} />
                    </Pressable>
                </>}
            </View>)}
        </ScrollView>
        {busy && !props.session.supportsSteer && <Text style={styles.hint}>{t('messageQueue.steerUnavailable')}</Text>}
        <Text style={styles.hint}>{t('messageQueue.hint')}</Text>
    </View>;
}

const styles = StyleSheet.create(theme => ({
    container: { backgroundColor: theme.colors.surface, borderColor: theme.colors.divider, borderWidth: 1, borderRadius: 16, padding: 8, marginBottom: 4 },
    heading: { color: theme.colors.textSecondary, fontSize: 12, paddingHorizontal: 8, paddingBottom: 4 },
    list: { maxHeight: 180 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 2 },
    content: { flex: 1, minWidth: 0, paddingHorizontal: 8 },
    text: { color: theme.colors.text, fontSize: 14 },
    secondary: { color: theme.colors.textSecondary, fontSize: 12 },
    hint: { color: theme.colors.textSecondary, fontSize: 11, paddingHorizontal: 8, paddingTop: 4 },
    action: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, minHeight: 44, minWidth: 44, paddingHorizontal: 6, borderRadius: 8, backgroundColor: theme.colors.surface },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    disabled: { opacity: 0.4 },
}));
