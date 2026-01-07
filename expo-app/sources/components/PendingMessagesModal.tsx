import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useSessionPendingMessages } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { sessionAbort } from '@/sync/ops';

export function PendingMessagesModal(props: { sessionId: string; onClose: () => void }) {
    const { theme } = useUnistyles();
    const { messages, isLoaded } = useSessionPendingMessages(props.sessionId);

    React.useEffect(() => {
        if (!isLoaded) {
            void sync.fetchPendingMessages(props.sessionId);
        }
    }, [isLoaded, props.sessionId]);

    const handleEdit = React.useCallback(async (pendingId: string, currentText: string) => {
        const next = await Modal.prompt(
            'Edit pending message',
            undefined,
            { defaultValue: currentText, confirmText: 'Save' }
        );
        if (next === null) return;
        if (!next.trim()) return;
        try {
            await sync.updatePendingMessage(props.sessionId, pendingId, next);
        } catch (e) {
            Modal.alert('Error', e instanceof Error ? e.message : 'Failed to update pending message');
        }
    }, [props.sessionId]);

    const handleRemove = React.useCallback(async (pendingId: string) => {
        const confirmed = await Modal.confirm(
            'Remove pending message?',
            'This will delete the pending message.',
            { confirmText: 'Remove', destructive: true }
        );
        if (!confirmed) return;
        try {
            await sync.deletePendingMessage(props.sessionId, pendingId);
        } catch (e) {
            Modal.alert('Error', e instanceof Error ? e.message : 'Failed to delete pending message');
        }
    }, [props.sessionId]);

    const handleSendNow = React.useCallback(async (pendingId: string, text: string) => {
        const confirmed = await Modal.confirm(
            'Send now?',
            'This will stop the current turn and send this message immediately.',
            { confirmText: 'Send now' }
        );
        if (!confirmed) return;

        try {
            await sync.deletePendingMessage(props.sessionId, pendingId);
            props.onClose();
            await sessionAbort(props.sessionId);
            await sync.sendMessage(props.sessionId, text);
        } catch (e) {
            Modal.alert('Error', e instanceof Error ? e.message : 'Failed to send pending message');
        }
    }, [props.sessionId, props.onClose]);

    return (
        <View style={{ padding: 16, width: '100%', maxWidth: 720 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 16, fontWeight: '700', color: theme.colors.text, ...Typography.default('semiBold') }}>
                    Pending messages
                </Text>
                <Pressable
                    onPress={props.onClose}
                    style={(p) => ({
                        padding: 8,
                        borderRadius: 10,
                        backgroundColor: p.pressed ? theme.colors.input.background : 'transparent'
                    })}
                >
                    <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            {!isLoaded && (
                <View style={{ paddingVertical: 24 }}>
                    <ActivityIndicator />
                </View>
            )}

            {isLoaded && messages.length === 0 && (
                <Text style={{ marginTop: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                    No pending messages.
                </Text>
            )}

            {messages.length > 0 && (
                <ScrollView style={{ marginTop: 12, maxHeight: 520 }}>
                    {messages.map((m) => (
                        <View
                            key={m.id}
                            style={{
                                borderRadius: 12,
                                backgroundColor: theme.colors.input.background,
                                padding: 12,
                                marginBottom: 10,
                            }}
                        >
                            <Text
                                numberOfLines={4}
                                style={{
                                    color: theme.colors.text,
                                    fontSize: 14,
                                    ...Typography.default(),
                                }}
                            >
                                {(m.displayText ?? m.text).trim()}
                            </Text>

                            <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                                <ActionButton
                                    title="Edit"
                                    onPress={() => handleEdit(m.id, m.text)}
                                    theme={theme}
                                />
                                <ActionButton
                                    title="Remove"
                                    onPress={() => handleRemove(m.id)}
                                    theme={theme}
                                    destructive
                                />
                                <ActionButton
                                    title="Send now"
                                    onPress={() => handleSendNow(m.id, m.text)}
                                    theme={theme}
                                />
                            </View>
                        </View>
                    ))}
                </ScrollView>
            )}
        </View>
    );
}

function ActionButton(props: {
    title: string;
    onPress: () => void;
    theme: any;
    destructive?: boolean;
}) {
    return (
        <Pressable
            onPress={props.onPress}
            style={(p) => ({
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 10,
                backgroundColor: props.destructive
                    ? (p.pressed ? props.theme.colors.box.danger.background : props.theme.colors.box.danger.background)
                    : (p.pressed ? props.theme.colors.button.secondary.background : props.theme.colors.button.secondary.background),
                opacity: p.pressed ? 0.85 : 1
            })}
        >
            <Text style={{
                color: props.destructive ? props.theme.colors.box.danger.text : props.theme.colors.button.secondary.tint,
                fontWeight: '600',
                ...Typography.default('semiBold')
            }}>
                {props.title}
            </Text>
        </Pressable>
    );
}

