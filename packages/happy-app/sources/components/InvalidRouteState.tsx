import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';

export const InvalidRouteState = React.memo(function InvalidRouteState(props: {
    title: string;
    description?: string;
    actionLabel: string;
    onAction: () => void;
}) {
    const { theme } = useUnistyles();

    return (
        <View style={styles.page}>
            <View style={styles.content}>
                <View style={styles.iconContainer}>
                    <Ionicons
                        name="alert-circle-outline"
                        size={48}
                        color={theme.colors.status.error}
                    />
                </View>
                <Text style={styles.title}>{props.title}</Text>
                {props.description ? (
                    <Text style={styles.description}>{props.description}</Text>
                ) : null}
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={props.actionLabel}
                    onPress={props.onAction}
                    style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
                >
                    <Text style={styles.actionText}>{props.actionLabel}</Text>
                </Pressable>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    page: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface,
        paddingHorizontal: theme.margins.xl,
        paddingVertical: theme.margins.xl,
    },
    content: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignItems: 'center',
    },
    iconContainer: {
        marginBottom: theme.margins.lg,
    },
    title: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 20,
        lineHeight: 28,
        textAlign: 'center',
    },
    description: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 15,
        lineHeight: 22,
        textAlign: 'center',
        marginTop: theme.margins.sm,
    },
    action: {
        minHeight: 44,
        minWidth: 160,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 12,
        paddingHorizontal: theme.margins.lg,
        paddingVertical: theme.margins.sm,
        marginTop: theme.margins.xl,
        backgroundColor: theme.colors.button.primary.background,
    },
    actionPressed: {
        opacity: 0.84,
    },
    actionText: {
        ...Typography.default('semiBold'),
        color: theme.colors.button.primary.tint,
        fontSize: 16,
        lineHeight: 22,
        textAlign: 'center',
    },
}));
