import * as React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import Animated, { useAnimatedStyle, useSharedValue, withTiming, interpolate } from 'react-native-reanimated';
import { useCollapsedSection } from '@/hooks/useCollapsedSections';

interface CollapsibleSectionHeaderProps {
    title: string;
    sectionId: string;
    sessionCount?: number;
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.groupped.background,
        paddingHorizontal: 24,
        paddingTop: 20,
        paddingBottom: 8,
    },
    pressable: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    leftContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    headerText: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.groupped.sectionTitle,
        letterSpacing: 0.1,
        ...Typography.default('semiBold'),
    },
    countText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    chevronContainer: {
        width: 20,
        height: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

export const CollapsibleSectionHeader = React.memo<CollapsibleSectionHeaderProps>(({
    title,
    sectionId,
    sessionCount
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const [collapsed, toggleCollapsed] = useCollapsedSection(sectionId);

    const chevronRotation = useSharedValue(collapsed ? 1 : 0);

    // Update chevron animation when collapsed changes
    React.useEffect(() => {
        chevronRotation.value = withTiming(collapsed ? 1 : 0, { duration: 200 });
    }, [collapsed, chevronRotation]);

    const chevronStyle = useAnimatedStyle(() => ({
        transform: [{ rotate: `${interpolate(chevronRotation.value, [0, 1], [0, -90])}deg` }],
    }));

    return (
        <View style={styles.container}>
            <Pressable
                onPress={toggleCollapsed}
                style={styles.pressable}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
                <View style={styles.leftContent}>
                    <Text style={styles.headerText}>
                        {title}
                    </Text>
                    {collapsed && sessionCount !== undefined && (
                        <Text style={styles.countText}>
                            ({sessionCount})
                        </Text>
                    )}
                </View>
                <Animated.View style={[styles.chevronContainer, chevronStyle]}>
                    <Ionicons
                        name="chevron-down"
                        size={16}
                        color={theme.colors.textSecondary}
                    />
                </Animated.View>
            </Pressable>
        </View>
    );
});
