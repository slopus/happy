import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { SelectableRow } from './SelectableRow';

export type ActionListItem = Readonly<{
    id: string;
    label: string;
    icon?: React.ReactNode;
    onPress?: () => void;
    disabled?: boolean;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    section: {
        paddingTop: 12,
        paddingBottom: 8
    },
    title: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        paddingHorizontal: 16,
        paddingBottom: 4,
        ...Typography.default('semiBold'),
        textTransform: 'uppercase',
    },
    label: {
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default(),
    },
}));

export function ActionListSection(props: {
    title?: string;
    actions: ReadonlyArray<ActionListItem | null | undefined>;
}) {
    const styles = stylesheet;
    useUnistyles();

    const actions = React.useMemo(() => {
        return (props.actions ?? []).filter(Boolean) as ActionListItem[];
    }, [props.actions]);

    if (actions.length === 0) return null;

    return (
        <View style={styles.section}>
            {props.title ? (
                <Text style={styles.title}>
                    {props.title}
                </Text>
            ) : null}

            {actions.map((action) => (
                <SelectableRow
                    key={action.id}
                    disabled={action.disabled}
                    onPress={action.onPress}
                    left={action.icon ? <View>{action.icon}</View> : null}
                    title={action.label}
                    titleStyle={styles.label}
                    variant="slim"
                />
            ))}
        </View>
    );
}
