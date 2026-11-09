import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

export function WorkspaceButton({ label, icon, onPress, selected, disabled, compact, testID }: {
    label: string; icon?: React.ComponentProps<typeof Ionicons>['name']; onPress: () => void;
    selected?: boolean; disabled?: boolean; compact?: boolean; testID?: string;
}) {
    const { theme } = useUnistyles();
    const [hover, setHover] = React.useState(false);
    return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress} testID={testID}
        {...(Platform.OS === 'web' ? { title: label } as any : {})}
        {...({ onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) } as any)}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 5, padding: 7, borderRadius: 7, opacity: disabled ? 0.45 : 1,
            backgroundColor: selected ? theme.colors.surfaceSelected : pressed || hover ? theme.colors.surfacePressed : 'transparent' })}>
        {icon && <Ionicons name={icon} size={16} color={theme.colors.textSecondary} />}
        {!compact && <Text style={{ fontSize: 12, color: theme.colors.text }}>{label}</Text>}
    </Pressable>;
}
