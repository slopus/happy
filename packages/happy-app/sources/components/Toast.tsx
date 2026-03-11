import * as React from 'react';
import { Animated, Text, StyleSheet, Platform, Keyboard } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';

let _show: ((message?: string) => void) | null = null;

/** Show a brief toast with a checkmark icon. Defaults to "Copied" text. */
export function showToast(message?: string) {
    _show?.(message);
}

/** Shorthand: show the "Copied" toast. */
export function showCopiedToast() {
    _show?.();
}

/**
 * Mount this component once at the app root.
 * It renders an absolutely-positioned toast that auto-fades.
 */
const BASE_BOTTOM = Platform.OS === 'ios' ? 100 : 80;

export function ToastHost() {
    const opacity = React.useRef(new Animated.Value(0)).current;
    const timeout = React.useRef<ReturnType<typeof setTimeout>>(undefined);
    const [message, setMessage] = React.useState('');
    const [bottomOffset, setBottomOffset] = React.useState(BASE_BOTTOM);

    React.useEffect(() => {
        if (Platform.OS !== 'ios') return;
        const showSub = Keyboard.addListener('keyboardWillShow', (e) => {
            setBottomOffset(e.endCoordinates.height + 20);
        });
        const hideSub = Keyboard.addListener('keyboardWillHide', () => {
            setBottomOffset(BASE_BOTTOM);
        });
        return () => { showSub.remove(); hideSub.remove(); };
    }, []);

    const show = React.useCallback((msg?: string) => {
        if (timeout.current) clearTimeout(timeout.current);
        setMessage(msg ?? t('common.copied'));
        opacity.setValue(1);
        timeout.current = setTimeout(() => {
            Animated.timing(opacity, { toValue: 0, duration: 400, useNativeDriver: true }).start();
        }, 1200);
    }, [opacity]);

    React.useEffect(() => {
        _show = show;
        return () => { _show = null; };
    }, [show]);

    return (
        <Animated.View pointerEvents="none" style={[toastStyles.container, { opacity, bottom: bottomOffset }]}>
            <Ionicons name="checkmark-circle" size={16} color="#fff" style={{ marginRight: 6 }} />
            <Text style={toastStyles.text}>{message}</Text>
        </Animated.View>
    );
}

const toastStyles = StyleSheet.create({
    container: {
        position: 'absolute',
        bottom: BASE_BOTTOM,
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(0,0,0,0.75)',
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 20,
        zIndex: 9999,
    },
    text: {
        color: '#fff',
        fontSize: 14,
        fontWeight: '500',
    },
});
