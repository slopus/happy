import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { PendingMessagesModal } from './PendingMessagesModal';

export const PendingQueueIndicator = React.memo((props: { sessionId: string; count: number }) => {
    const { theme } = useUnistyles();

    if (props.count <= 0) return null;

    return (
        <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
            <Pressable
                onPress={() => {
                    Modal.show({
                        component: PendingMessagesModal,
                        props: { sessionId: props.sessionId }
                    });
                }}
                style={(p) => ({
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
                    <Text style={{
                        marginLeft: 8,
                        color: theme.colors.text,
                        fontSize: 13,
                        fontWeight: '600',
                        ...Typography.default('semiBold')
                    }}>
                        Pending ({props.count})
                    </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
            </Pressable>
        </View>
    );
});

