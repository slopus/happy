import React from 'react';
import { StatusBar as RNStatusBar, Platform, Keyboard } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';


export const StatusBarProvider = React.memo(() => {
    const { theme } = useUnistyles();
    const barStyle = theme.dark ? 'light-content' : 'dark-content';

    // Re-apply status bar style when keyboard appears.
    // In edge-to-edge mode, keyboard insets changes can reset the native
    // lightStatusBar flag, causing the status bar to revert to the wrong style.
    React.useEffect(() => {
        const event = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
        const subscription = Keyboard.addListener(event, () => {
            RNStatusBar.setBarStyle(barStyle, false);
        });
        return () => subscription.remove();
    }, [barStyle]);

    return (
        <RNStatusBar
            barStyle={barStyle}
            animated={true}
            translucent={true}
            backgroundColor="transparent"
        />
    );
});