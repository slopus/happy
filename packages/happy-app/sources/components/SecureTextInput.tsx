import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import {
    ActivityIndicator,
    Pressable,
    TextInput,
    type TextInputProps,
    View,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';

type Props = Omit<TextInputProps, 'secureTextEntry' | 'style'> & {
    emptyValueAccessibilityLabel: string;
    hideValueAccessibilityLabel: string;
    onHideStoredValue?: () => void;
    onRevealStoredValue?: () => void;
    showValueAccessibilityLabel: string;
    storedValueAvailable?: boolean;
    storedValueRevealed?: boolean;
    visibilityButtonLoading?: boolean;
    visibilityButtonTestID?: string;
};

export const SecureTextInput = React.memo(React.forwardRef<TextInput, Props>(function SecureTextInput({
    emptyValueAccessibilityLabel,
    hideValueAccessibilityLabel,
    onHideStoredValue,
    onRevealStoredValue,
    showValueAccessibilityLabel,
    storedValueAvailable = false,
    storedValueRevealed = false,
    value,
    visibilityButtonLoading = false,
    visibilityButtonTestID,
    ...inputProps
}, ref) {
    const { theme } = useUnistyles();
    const [valueVisible, setValueVisible] = React.useState(false);
    const pendingStoredRevealRef = React.useRef(false);
    const hasValue = Boolean(value?.length);
    const canToggleVisibility = hasValue || storedValueAvailable;

    React.useEffect(() => {
        if (!hasValue) setValueVisible(false);
        if (pendingStoredRevealRef.current && hasValue && storedValueRevealed) {
            pendingStoredRevealRef.current = false;
            setValueVisible(true);
        }
    }, [hasValue, storedValueRevealed]);

    const toggleVisibility = React.useCallback(() => {
        if (visibilityButtonLoading) return;
        if (!hasValue) {
            if (!storedValueAvailable) return;
            pendingStoredRevealRef.current = true;
            onRevealStoredValue?.();
            return;
        }
        if (valueVisible) {
            setValueVisible(false);
            if (storedValueRevealed) onHideStoredValue?.();
            return;
        }
        setValueVisible(true);
    }, [hasValue, onHideStoredValue, onRevealStoredValue, storedValueAvailable, storedValueRevealed, valueVisible, visibilityButtonLoading]);

    return (
        <View style={styles.container}>
            <TextInput
                {...inputProps}
                ref={ref}
                secureTextEntry={!hasValue || !valueVisible}
                style={styles.input}
                value={value}
            />
            <Pressable
                accessibilityLabel={!canToggleVisibility
                    ? emptyValueAccessibilityLabel
                    : valueVisible
                        ? hideValueAccessibilityLabel
                        : showValueAccessibilityLabel}
                accessibilityRole="button"
                accessibilityState={{ disabled: !canToggleVisibility || visibilityButtonLoading }}
                disabled={!canToggleVisibility || visibilityButtonLoading}
                hitSlop={6}
                onPress={toggleVisibility}
                style={({ pressed }) => [
                    styles.visibilityButton,
                    (!canToggleVisibility || visibilityButtonLoading) && styles.disabled,
                    pressed && canToggleVisibility && !visibilityButtonLoading && styles.pressed,
                ]}
                testID={visibilityButtonTestID}
            >
                {visibilityButtonLoading ? (
                    <ActivityIndicator color={theme.colors.textSecondary} size="small" />
                ) : (
                    <Ionicons
                        color={theme.colors.textSecondary}
                        name={valueVisible ? 'eye-off-outline' : 'eye-outline'}
                        size={22}
                    />
                )}
            </Pressable>
        </View>
    );
}));

const styles = StyleSheet.create((theme) => ({
    container: {
        alignItems: 'center',
        backgroundColor: theme.colors.input.background,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row',
        minHeight: 44,
        overflow: 'hidden',
    },
    input: {
        ...Typography.default(),
        color: theme.colors.text,
        flex: 1,
        fontSize: 15,
        minHeight: 44,
        paddingLeft: 12,
        paddingRight: 4,
    },
    visibilityButton: {
        alignItems: 'center',
        alignSelf: 'stretch',
        justifyContent: 'center',
        minHeight: 44,
        width: 44,
    },
    pressed: {
        opacity: 0.55,
    },
    disabled: {
        opacity: 0.4,
    },
}));
