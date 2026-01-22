import * as React from 'react';
import { Text, View, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

interface CodeViewProps {
    code: string;
    language?: string;
}

export const CodeView = React.memo<CodeViewProps>(({ 
    code, 
    language
}) => {
    return (
        <View style={styles.codeBlock}>
            <Text style={styles.codeText}>{code}</Text>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    codeBlock: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 6,
        padding: 12,
    },
    codeText: {
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
        fontSize: 12,
        color: theme.colors.text,
        lineHeight: 18,
    },
}));