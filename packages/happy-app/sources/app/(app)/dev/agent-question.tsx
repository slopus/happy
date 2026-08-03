import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/StyledText';
import { ItemGroup } from '@/components/ItemGroup';
import { Typography } from '@/constants/Typography';
import { AgentQuestionBannerView } from '@/components/AgentQuestionBanner';
import { AgentQuestionModal } from '@/components/AgentQuestionModal';
import type { PendingAgentForm, PendingUnsupportedCommunication } from '@/sync/agentCommunications';

const formCommunication: PendingAgentForm = {
    id: 'demo-form',
    createdAt: 0,
    kind: 'form',
    questions: [
        {
            id: 'q1',
            header: 'Storage',
            question: 'Where should the project order live?',
            multiSelect: false,
            options: [
                { label: 'In settings', description: 'Synced to every device you sign in from' },
                { label: 'On this device', description: 'Stays local, never leaves the phone' },
            ],
        },
        {
            id: 'q2',
            header: 'Scope',
            question: 'Which surfaces should it apply to?',
            multiSelect: true,
            options: [
                { label: 'Mobile', description: 'The phone session list' },
                { label: 'Tablet sidebar', description: 'The split-view sidebar' },
                { label: 'Desktop', description: 'The Tauri app' },
            ],
        },
    ],
};

const unsupportedCommunication: PendingUnsupportedCommunication = {
    id: 'demo-unsupported',
    createdAt: 0,
    kind: 'unsupported',
    rawKind: 'file_pick',
    title: 'Choose a file to review',
};

export default function AgentQuestionDemoScreen() {
    const styles = stylesheet;
    // ?open=1 opens the sheet straight away, so it can be linked to and captured directly.
    const params = useLocalSearchParams<{ open?: string }>();
    const [open, setOpen] = React.useState(params.open === '1');

    return (
        <>
            <Stack.Screen options={{ headerTitle: 'Agent Questions' }} />
            <ScrollView style={styles.container} contentContainerStyle={styles.content}>
                <Text style={styles.description}>
                    Agent-to-user communications. A form opens the full-screen answer sheet; a kind
                    this build does not implement says so and offers to dismiss it.
                </Text>

                <ItemGroup title="Banner — form">
                    <View style={styles.preview}>
                        <AgentQuestionBannerView
                            pending={formCommunication}
                            onPress={() => setOpen(true)}
                        />
                    </View>
                </ItemGroup>

                <ItemGroup title="Banner — unsupported kind">
                    <View style={styles.preview}>
                        <AgentQuestionBannerView pending={unsupportedCommunication} />
                    </View>
                </ItemGroup>

                <ItemGroup title="Full-screen form">
                    <Pressable style={styles.button} onPress={() => setOpen(true)}>
                        <Text style={styles.buttonText}>Open the answer sheet</Text>
                    </Pressable>
                </ItemGroup>
            </ScrollView>

            <AgentQuestionModal
                pending={formCommunication}
                sessionId="demo-session"
                visible={open}
                onClose={() => setOpen(false)}
            />
        </>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    content: {
        paddingVertical: 16,
        gap: 8,
    },
    description: {
        paddingHorizontal: 20,
        paddingBottom: 8,
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    preview: {
        paddingVertical: 8,
    },
    button: {
        margin: 12,
        height: 48,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.textLink,
    },
    buttonText: {
        fontSize: 16,
        color: '#fff',
        ...Typography.default('semiBold'),
    },
}));
