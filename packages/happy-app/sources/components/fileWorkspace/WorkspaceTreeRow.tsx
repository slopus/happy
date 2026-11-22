import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';

type WorkspaceTreeRowProps = {
    title: string;
    label: string;
    depth?: number;
    expanded?: boolean;
    reserveDisclosure?: boolean;
    icon?: React.ComponentProps<typeof Ionicons>['name'];
    selected?: boolean;
    badge?: React.ReactNode;
    trailing?: React.ReactNode;
    onPress: () => void;
    testID?: string;
};

/** A compact directory-style row. Adjacent actions remain independent buttons. */
export const WorkspaceTreeRow = React.memo(function WorkspaceTreeRow({
    title, label, depth = 0, expanded, reserveDisclosure = false, icon, selected = false, badge, trailing, onPress, testID,
}: WorkspaceTreeRowProps) {
    const { theme } = useUnistyles();
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    return <View style={styles.container}>
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected, expanded }}
            onPress={onPress}
            onHoverIn={() => setHovered(true)}
            onHoverOut={() => setHovered(false)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            testID={testID}
            style={({ pressed }) => [
                styles.main,
                { paddingLeft: 12 + depth * 14 },
                selected ? styles.selected : hovered || pressed ? styles.pressed : undefined,
                Platform.OS === 'web' ? {
                    outlineStyle: 'solid' as const,
                    outlineWidth: focused ? 1 : 0,
                    outlineColor: theme.colors.textLink,
                    outlineOffset: -1,
                } : undefined,
            ]}
        >
            {expanded !== undefined
                ? <Ionicons name={expanded ? 'chevron-down-outline' : 'chevron-forward-outline'} size={15} color={theme.colors.textSecondary} />
                : reserveDisclosure ? <View style={styles.disclosureSpace} /> : null}
            {icon && <Ionicons name={icon} size={15} color={theme.colors.textSecondary} />}
            <Text numberOfLines={1} ellipsizeMode="tail" style={styles.title}>{title}</Text>
            {badge != null && <View style={styles.accessory}>{badge}</View>}
        </Pressable>
        {trailing != null && <View style={styles.accessory}>{trailing}</View>}
    </View>;
});

const styles = StyleSheet.create(theme => ({
    container: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', minWidth: 0 },
    main: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', padding: 8, gap: 7, backgroundColor: 'transparent' },
    title: { flex: 1, minWidth: 0, fontSize: 12, color: theme.colors.text },
    accessory: { flexDirection: 'row', alignItems: 'center', flexGrow: 0, flexShrink: 0 },
    disclosureSpace: { width: 15, flexShrink: 0 },
    selected: { backgroundColor: theme.colors.surfaceSelected },
    pressed: { backgroundColor: theme.colors.surfacePressed },
}));
