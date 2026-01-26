import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function useKeyboardHeight(): number {
    const safeArea = useSafeAreaInsets();
    const keyboard = useKeyboardState();

    if (!keyboard.isVisible) return 0;

    // `react-native-keyboard-controller`'s `height` includes the bottom inset on iOS.
    // Subtract it so callers can treat this as "additional occupied height".
    return Math.max(0, keyboard.height - safeArea.bottom);
}

