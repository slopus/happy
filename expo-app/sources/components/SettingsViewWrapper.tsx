import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SettingsView } from './SettingsView';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
}));

export const SettingsViewWrapper = React.memo(() => {
    const styles = stylesheet;

    return (
        <View style={styles.container}>
            <SettingsView />
        </View>
    );
});