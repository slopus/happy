import * as React from 'react';
import { Text, View, StyleSheet, Platform, ScrollView } from 'react-native';

interface CommandViewProps {
    command: string;
    prompt?: string;
}

export const CommandView = React.memo<CommandViewProps>(({ 
    command, 
    prompt = '$' 
}) => {
    return (
        <View style={styles.container}>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.scrollView}
                contentContainerStyle={styles.scrollContent}
            >
                <Text style={styles.commandText}>
                    <Text style={styles.promptText}>{prompt} </Text>
                    {command}
                </Text>
            </ScrollView>
        </View>
    );
});

const styles = StyleSheet.create({
    container: {
        backgroundColor: '#1E1E1E',
        borderRadius: 6,
        overflow: 'hidden',
    },
    scrollView: {
        maxHeight: 40,
    },
    scrollContent: {
        paddingHorizontal: 10,
        paddingVertical: 10,
    },
    commandText: {
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        fontSize: 13,
        color: '#E0E0E0',
        lineHeight: 16,
    },
    promptText: {
        color: '#34C759',
        fontWeight: '600',
    },
});