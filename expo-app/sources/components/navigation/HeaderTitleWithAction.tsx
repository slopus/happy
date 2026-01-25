import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

export type HeaderTitleWithActionProps = {
    title: string;
    tintColor?: string;
    actionLabel: string;
    actionIconName: React.ComponentProps<typeof Ionicons>['name'];
    actionColor?: string;
    actionDisabled?: boolean;
    actionLoading?: boolean;
    onActionPress: () => void;
};

export const HeaderTitleWithAction = React.memo((props: HeaderTitleWithActionProps) => {
    const styles = stylesheet;

    return (
        <View style={styles.container}>
            <Text
                style={[styles.title, { color: props.tintColor ?? '#000' }]}
                numberOfLines={1}
                accessibilityRole="header"
            >
                {props.title}
            </Text>
            <Pressable
                onPress={props.onActionPress}
                hitSlop={10}
                style={({ pressed }) => [styles.actionButton, pressed && styles.actionButtonPressed]}
                accessibilityRole="button"
                accessibilityLabel={props.actionLabel}
                disabled={props.actionDisabled === true}
            >
                {props.actionLoading === true
                    ? <ActivityIndicator size="small" color={props.actionColor ?? props.tintColor ?? '#000'} />
                    : <Ionicons name={props.actionIconName} size={18} color={props.actionColor ?? props.tintColor ?? '#000'} />}
            </Pressable>
        </View>
    );
});

const stylesheet = StyleSheet.create(() => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        maxWidth: '100%',
    },
    title: {
        fontSize: 17,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    actionButton: {
        padding: 2,
    },
    actionButtonPressed: {
        opacity: 0.7,
    },
}));

