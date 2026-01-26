import * as React from 'react';
import { Keyboard, Platform, type KeyboardEvent } from 'react-native';

function getKeyboardHeight(e?: KeyboardEvent): number {
    const h = e?.endCoordinates?.height;
    return typeof h === 'number' && Number.isFinite(h) ? h : 0;
}

export function useKeyboardHeight(): number {
    const [height, setHeight] = React.useState(0);

    React.useEffect(() => {
        if (Platform.OS === 'web') return;
        if (typeof (Keyboard as any)?.addListener !== 'function') return;

        const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
        const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

        const showSub = Keyboard.addListener(showEvent as any, (e: KeyboardEvent) => {
            setHeight(getKeyboardHeight(e));
        });
        const hideSub = Keyboard.addListener(hideEvent as any, () => {
            setHeight(0);
        });

        return () => {
            showSub.remove();
            hideSub.remove();
        };
    }, []);

    return height;
}
