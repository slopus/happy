import * as React from 'react';
import { Text, View, ScrollView, StyleSheet, Platform } from 'react-native';

interface CodeViewProps {
    code: string;
    language?: string;
    maxHeight?: number;
    horizontal?: boolean;
}

export const CodeView = React.memo<CodeViewProps>(({ 
    code, 
    language, 
    maxHeight = 300,
    horizontal = false 
}) => {
    const content = (
        <View style={styles.codeBlock}>
            <Text style={styles.codeText}>{code}</Text>
        </View>
    );

    if (horizontal) {
        return (
            <ScrollView
                style={[styles.scroll, maxHeight ? { maxHeight } : null]}
                horizontal
                showsHorizontalScrollIndicator={true}
            >
                {content}
            </ScrollView>
        );
    }

    return (
        <View style={[styles.container, maxHeight ? { maxHeight } : null]}>
            <ScrollView showsVerticalScrollIndicator={true}>
                {content}
            </ScrollView>
        </View>
    );
});

const styles = StyleSheet.create({
    container: {
        overflow: 'hidden',
    },
    scroll: {
        overflow: 'hidden',
    },
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