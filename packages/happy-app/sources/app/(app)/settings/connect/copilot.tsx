import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/StyledText';
import { StyleSheet } from 'react-native-unistyles';
import { Platform } from 'react-native';

export default function CopilotConnect() {
    return (
        <OAuthViewUnsupported name="GitHub Copilot" command="happy connect copilot" />
    );
}

const OAuthViewUnsupported = React.memo((props: {
    name: string;
    command?: string;
}) => {
    const command = props.command || `happy connect ${props.name.toLowerCase()}`;

    return (
        <View style={styles.unsupportedContainer}>
            <Text style={styles.unsupportedTitle}>Connect {props.name}</Text>
            <Text style={styles.unsupportedText}>
                Run the following command in your terminal:
            </Text>
            <View style={styles.terminalContainer}>
                <Text style={styles.terminalCommand}>
                    <Text style={styles.terminalPrompt}>$ </Text>
                    {command}
                </Text>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    unsupportedContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
        backgroundColor: theme.colors.surface,
    },
    unsupportedTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 20,
    },
    unsupportedText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginBottom: 24,
    },
    terminalContainer: {
        backgroundColor: '#1e1e1e',
        borderRadius: 8,
        padding: 16,
        minWidth: 280,
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.1)',
    },
    terminalPrompt: {
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        fontSize: 14,
        color: '#00ff00',
    },
    terminalCommand: {
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        fontSize: 14,
        color: '#ffffff',
    },
}));
