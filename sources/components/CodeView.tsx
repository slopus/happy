import * as React from 'react';
import { Text, View, StyleSheet, Platform } from 'react-native';

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

const styles = StyleSheet.create({
    codeBlock: {
        backgroundColor: '#1E1E1E',
        borderRadius: 6,
        padding: 12,
    },
    codeText: {
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        fontSize: 12,
        color: '#E0E0E0',
        lineHeight: 18,
    },
});