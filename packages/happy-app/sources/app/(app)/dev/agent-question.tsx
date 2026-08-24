import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { Stack } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';

import { MessageView } from '@/components/MessageView';
import type { Message, ToolCall } from '@/sync/typesMessage';

const PREVIEW_TIME = 1_750_000_000_000;
const QUESTION = 'Where should the migration plan live?';

function toolMessage(id: string, tool: ToolCall, offset: number): Message {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: PREVIEW_TIME + offset,
        tool,
        children: [],
    };
}

const messages: Message[] = [
    {
        kind: 'agent-text',
        id: 'question-preview-intro',
        localId: null,
        createdAt: PREVIEW_TIME,
        text: 'This question is live. Pick an answer and submit it; the block should stay exactly where it is.',
    },
    toolMessage('question-preview-pending', {
        callId: 'question-preview-pending-call',
        name: 'AskUserQuestion',
        state: 'running',
        input: {
            questions: [{
                header: 'Migration gate plan',
                question: QUESTION,
                options: [
                    { label: 'In this chat', description: 'Keep the plan beside the discussion' },
                    { label: 'In a plan file', description: 'Save it for future sessions' },
                ],
                multiSelect: false,
            }],
        },
        createdAt: PREVIEW_TIME + 1,
        startedAt: PREVIEW_TIME + 1,
        completedAt: null,
        description: null,
        permission: { id: 'question-preview-permission', status: 'pending' },
    }, 1),
    {
        kind: 'agent-text',
        id: 'question-preview-history-label',
        localId: null,
        createdAt: PREVIEW_TIME + 2,
        text: 'Older questions remain in the transcript with their final state:',
    },
    toolMessage('question-preview-superseded', {
        callId: 'question-preview-superseded-call',
        name: 'request_user_input',
        state: 'error',
        input: {
            questions: [{
                header: 'Migration gate plan',
                question: 'Approve this scoped plan?',
                options: [{
                    choices: [
                        { label: 'Approve', description: 'Proceed with this scope' },
                        { label: 'Revise', description: 'Change the scope first' },
                    ],
                    multiSelect: false,
                }],
            }],
        },
        createdAt: PREVIEW_TIME + 3,
        startedAt: PREVIEW_TIME + 3,
        completedAt: PREVIEW_TIME + 4,
        description: null,
        result: 'The arguments did not match the tool schema.',
    }, 3),
    toolMessage('question-preview-answered', {
        callId: 'question-preview-answered-call',
        name: 'AskUserQuestion',
        state: 'completed',
        input: {
            questions: [{
                header: 'Storage',
                question: QUESTION,
                options: [
                    { label: 'In this chat', description: 'Keep the plan beside the discussion' },
                    { label: 'In a plan file', description: 'Save it for future sessions' },
                ],
                multiSelect: false,
            }],
            answers: { [QUESTION]: 'In this chat' },
        },
        createdAt: PREVIEW_TIME + 5,
        startedAt: PREVIEW_TIME + 5,
        completedAt: PREVIEW_TIME + 6,
        description: null,
        result: JSON.stringify({ answers: ['In this chat'] }),
    }, 5),
];

export default function AgentQuestionDemoScreen() {
    return (
        <View style={styles.screen}>
            <Stack.Screen options={{ headerTitle: 'Inline Questions' }} />
            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
            >
                <View style={styles.transcript} testID="agent-question-transcript">
                    {messages.map(message => (
                        <MessageView
                            key={message.id}
                            message={message}
                            metadata={null}
                            sessionId=""
                        />
                    ))}
                </View>
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    screen: {
        flex: 1,
        backgroundColor: Platform.select({
            web: theme.colors.surface,
            default: theme.colors.groupped.background,
        }),
    },
    scrollView: {
        flex: 1,
    },
    content: {
        paddingTop: 20,
        paddingBottom: 48,
    },
    transcript: {
        width: '100%',
        maxWidth: 760,
        alignSelf: 'center',
    },
}));