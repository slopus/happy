import * as React from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { ProviderIcon } from '@/components/ProviderIcon';
import { MessageView } from '@/components/MessageView';
import { fileEditToolFixtures } from '@/components/tools/fileEditToolFixtures';
import type { Message } from '@/sync/typesMessage';

const PREVIEW_SESSION_ID = '';
const PREVIEW_TIME = 1_750_000_000_000;

const introMessages: Message[] = [
    {
        kind: 'user-text',
        id: 'file-edit-preview-user',
        localId: null,
        createdAt: PREVIEW_TIME,
        text: 'Show me how file edits from Claude and Codex look in the mobile chat.',
    },
    {
        kind: 'agent-text',
        id: 'file-edit-preview-intro',
        localId: null,
        createdAt: PREVIEW_TIME + 1,
        text: 'Here are the real producer shapes, rendered by the same tool views used in a session.',
    },
];

const closingMessage: Message = {
    kind: 'agent-text',
    id: 'file-edit-preview-complete',
    localId: null,
    createdAt: PREVIEW_TIME + 10,
    text: 'Both paths end in the shared highlighted diff renderer. Expand the Codex edited-file row to inspect its diff.',
};

export default function FileEditToolsPreviewScreen() {
    return (
        <View style={styles.screen}>
            <Stack.Screen options={{ headerTitle: 'File Edit Preview' }} />
            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
            >
                <View style={styles.transcript}>
                    {introMessages.map((message) => (
                        <MessageView
                            key={message.id}
                            message={message}
                            metadata={null}
                            sessionId={PREVIEW_SESSION_ID}
                        />
                    ))}

                    {fileEditToolFixtures.map((fixture, index) => {
                        const message: Message = {
                            kind: 'tool-call',
                            id: `file-edit-preview-${fixture.id}`,
                            localId: null,
                            createdAt: PREVIEW_TIME + index + 2,
                            tool: fixture.tool,
                            children: [],
                        };

                        return (
                            <View key={fixture.id} style={styles.fixtureGroup}>
                                <View style={styles.fixtureLabel}>
                                    <ProviderIcon kind={fixture.provider} size={14} />
                                    <Text style={styles.fixtureLabelText}>{fixture.label}</Text>
                                    <Text style={styles.fixtureShape} numberOfLines={1}>
                                        {fixture.sourceName === fixture.tool.name
                                            ? fixture.sourceName
                                            : `${fixture.sourceName} → ${fixture.tool.name}`}
                                    </Text>
                                </View>
                                <MessageView
                                    message={message}
                                    metadata={null}
                                    sessionId={PREVIEW_SESSION_ID}
                                />
                            </View>
                        );
                    })}

                    <MessageView
                        message={closingMessage}
                        metadata={null}
                        sessionId={PREVIEW_SESSION_ID}
                    />
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
    fixtureGroup: {
        marginBottom: 18,
    },
    fixtureLabel: {
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        maxWidth: '90%',
        marginBottom: 2,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: Platform.OS === 'web' ? 1 : StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    fixtureLabelText: {
        color: theme.colors.text,
        fontSize: 12,
        fontWeight: '600',
    },
    fixtureShape: {
        flexShrink: 1,
        color: theme.colors.textSecondary,
        fontSize: 11,
        fontFamily: 'monospace',
    },
}));