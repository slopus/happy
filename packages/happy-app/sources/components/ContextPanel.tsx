import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

// P0: Static placeholder. P1 (R15) will add Changed/All file list + diff viewer.
export const ContextPanel = React.memo(() => {
    return (
        <View style={styles.container}>
            <Text style={styles.placeholder}>Context panel{'\n'}Coming soon</Text>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: theme.colors.surface,
    },
    placeholder: {
        color: theme.colors.textSecondary,
        fontSize: 14,
        textAlign: 'center',
    },
}));
