import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { useUnistyles } from 'react-native-unistyles';


export const StatusBarProvider = React.memo(() => {
    const { theme } = useUnistyles();
    const statusBarStyle = theme.dark ? 'light' : 'dark';
    return (
        <StatusBar style={statusBarStyle} animated={true} />
    );
});