import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export type WizardSectionHeaderRowAction = {
    accessibilityLabel: string;
    iconName: React.ComponentProps<typeof Ionicons>['name'];
    iconColor?: string;
    onPress: () => void;
};

export type WizardSectionHeaderRowProps = {
    rowStyle?: any;
    iconName: React.ComponentProps<typeof Ionicons>['name'];
    iconColor?: string;
    title: string;
    titleStyle?: any;
    action?: WizardSectionHeaderRowAction;
};

export const WizardSectionHeaderRow = React.memo((props: WizardSectionHeaderRowProps) => {
    return (
        <View style={props.rowStyle}>
            <Ionicons name={props.iconName} size={18} color={props.iconColor} />
            <Text style={props.titleStyle}>{props.title}</Text>
            {props.action ? (
                <Pressable
                    onPress={props.action.onPress}
                    hitSlop={10}
                    style={{ padding: 2 }}
                    accessibilityRole="button"
                    accessibilityLabel={props.action.accessibilityLabel}
                >
                    <Ionicons
                        name={props.action.iconName}
                        size={18}
                        color={props.action.iconColor}
                    />
                </Pressable>
            ) : null}
        </View>
    );
});

