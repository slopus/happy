import * as React from 'react';
import { View, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useSidebar } from './SidebarContext';

const stylesheet = StyleSheet.create((theme) => ({
    wrapper: {
        width: 12,
        backgroundColor: theme.colors.groupped.background,
        borderRightWidth: StyleSheet.hairlineWidth,
        borderRightColor: theme.colors.divider,
    },
    container: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    containerPressed: {
        backgroundColor: theme.colors.divider,
    },
}));

export const CollapsibleSidebarEdge = React.memo(() => {
    const { theme } = useUnistyles();
    const { isCollapsed, toggleCollapsed } = useSidebar();

    return (
        <View style={stylesheet.wrapper}>
            <Pressable
                onPress={toggleCollapsed}
                style={({ pressed }) => [
                    stylesheet.container,
                    pressed && stylesheet.containerPressed,
                ]}
            >
                <Ionicons
                    name={isCollapsed ? 'chevron-forward' : 'chevron-back'}
                    size={16}
                    color={theme.colors.textSecondary}
                />
            </Pressable>
        </View>
    );
});
