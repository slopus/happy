import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export type ItemGroupTitleAction = {
    accessibilityLabel: string;
    iconName: React.ComponentProps<typeof Ionicons>['name'];
    iconColor?: string;
    disabled?: boolean;
    loading?: boolean;
    onPress: () => void;
};

export type ItemGroupTitleWithActionProps = {
    title: string;
    titleStyle?: any;
    containerStyle?: any;
    action?: ItemGroupTitleAction;
};

export const ItemGroupTitleWithAction = React.memo((props: ItemGroupTitleWithActionProps) => {
    return (
        <View style={[{ flexDirection: 'row', alignItems: 'center' }, props.containerStyle]}>
            <Text style={props.titleStyle} numberOfLines={1}>
                {props.title}
            </Text>
            {props.action ? (
                <Pressable
                    onPress={props.action.onPress}
                    hitSlop={10}
                    style={{ padding: 2, marginLeft: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel={props.action.accessibilityLabel}
                    disabled={props.action.disabled === true}
                >
                    {props.action.loading === true
                        ? <ActivityIndicator size="small" color={props.action.iconColor} />
                        : <Ionicons name={props.action.iconName} size={18} color={props.action.iconColor} />}
                </Pressable>
            ) : null}
        </View>
    );
});

