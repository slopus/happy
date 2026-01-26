import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { PendingMessagesModal } from './PendingMessagesModal';
import { layout } from '@/components/layout';

const PENDING_INDICATOR_DEBOUNCE_MS = 250;

export const PendingQueueIndicator = React.memo((props: { sessionId: string; count: number; preview?: string }) => {
    const { theme } = useUnistyles();
    const [visible, setVisible] = React.useState(false);
    const debounceTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => {
        if (props.count <= 0) {
            if (debounceTimer.current) {
                clearTimeout(debounceTimer.current);
                debounceTimer.current = null;
            }
            if (visible) setVisible(false);
            return;
        }
        if (visible) return;
        if (debounceTimer.current) return;

        debounceTimer.current = setTimeout(() => {
            debounceTimer.current = null;
            setVisible(true);
        }, PENDING_INDICATOR_DEBOUNCE_MS);
        return () => {
            if (debounceTimer.current) {
                clearTimeout(debounceTimer.current);
                debounceTimer.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.count, visible]);

    if (props.count <= 0) return null;
    if (!visible) return null;

    return (
        <View style={{ alignItems: 'center', paddingBottom: 8 }}>
            <View style={{ width: '100%', maxWidth: layout.maxWidth, paddingHorizontal: 12 }}>
                <Pressable
                    onPress={() => {
                        Modal.show({
                            component: PendingMessagesModal,
                            props: { sessionId: props.sessionId }
                        });
                    }}
                    style={(p) => ({
                        width: '100%',
                        backgroundColor: theme.colors.input.background,
                        borderRadius: 14,
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        opacity: p.pressed ? 0.85 : 1
                    })}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <Ionicons name="time-outline" size={16} color={theme.colors.textSecondary} />
                        <View style={{ marginLeft: 8, flexShrink: 1 }}>
                            <Text style={{
                                color: theme.colors.text,
                                fontSize: 13,
                                fontWeight: '600',
                                ...Typography.default('semiBold')
                            }}>
                                Pending ({props.count})
                            </Text>
                            {props.preview ? (
                                <Text
                                    numberOfLines={1}
                                    style={{
                                        marginTop: 2,
                                        color: theme.colors.textSecondary,
                                        fontSize: 12,
                                        ...Typography.default(),
                                    }}
                                >
                                    {props.preview.trim()}
                                </Text>
                            ) : null}
                        </View>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
                </Pressable>
            </View>
        </View>
    );
});
