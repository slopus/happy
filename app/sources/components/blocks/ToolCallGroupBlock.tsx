import React, { useState } from 'react';
import { View, Text, TouchableOpacity, useWindowDimensions } from 'react-native';
import { type ToolCallGroupMessage, type Message, type ToolCallMessage } from '@/sync/typesMessage';
import { type Metadata } from '@/sync/storageTypes';
import { CompactToolBlock } from './RenderToolCallV4';

interface ToolCallGroupBlockProps {
    message: ToolCallGroupMessage;
    metadata: Metadata | null;
    sessionId: string;
    // Function to get messages by their IDs
    getMessageById: (id: string) => Message | null;
}

export function ToolCallGroupBlock({
    message,
    metadata,
    sessionId,
    getMessageById
}: ToolCallGroupBlockProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const { width } = useWindowDimensions();
    const isNarrowScreen = width < 700;

    // Get the actual tool call messages
    const toolCallMessages = message.messageIds
        .map(id => getMessageById(id))
        .filter((msg): msg is ToolCallMessage => msg !== null && msg.kind === 'tool-call');

    const toolCount = toolCallMessages.length;

    // Header component
    const Header = () => (
        <TouchableOpacity
            onPress={() => setIsExpanded(!isExpanded)}
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: 12,
                backgroundColor: '#f8f9fa',
                borderRadius: isNarrowScreen ? 8 : 0,
                borderWidth: isNarrowScreen ? 0 : 1,
                borderColor: '#e0e0e0',
                borderTopLeftRadius: 8,
                borderTopRightRadius: 8,
                borderBottomLeftRadius: isExpanded ? 0 : 8,
                borderBottomRightRadius: isExpanded ? 0 : 8,
            }}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: '#666' }}>
                    Tool Group
                </Text>
                <View
                    style={{
                        backgroundColor: '#e0e0e0',
                        borderRadius: 12,
                        paddingHorizontal: 8,
                        paddingVertical: 2,
                    }}
                >
                    <Text style={{ fontSize: 12, color: '#666' }}>
                        {toolCount} tool{toolCount !== 1 ? 's' : ''}
                    </Text>
                </View>
            </View>
            <Text style={{ fontSize: 16, color: '#666' }}>
                {isExpanded ? '−' : '+'}
            </Text>
        </TouchableOpacity>
    );

    // Content component
    const Content = () => (
        <View
            style={{
                borderWidth: isNarrowScreen ? 0 : 1,
                borderColor: '#e0e0e0',
                borderTopWidth: 0,
                borderBottomLeftRadius: 8,
                borderBottomRightRadius: 8,
                backgroundColor: 'white',
            }}
        >
            {toolCallMessages.map((toolMsg, index) => (
                <View key={toolMsg.id}>
                    {toolMsg.tools.map((tool, toolIndex) => (
                        <View
                            key={toolIndex}
                            style={{
                                borderBottomWidth: (index < toolCallMessages.length - 1 || toolIndex < toolMsg.tools.length - 1) ? 1 : 0,
                                borderBottomColor: '#f0f0f0',
                            }}
                        >
                            <CompactToolBlock
                                tool={tool}
                                sessionId={sessionId}
                                messageId={toolMsg.id}
                                metadata={metadata}
                            />
                        </View>
                    ))}
                </View>
            ))}
        </View>
    );

    if (isNarrowScreen) {
        // Mobile drawer behavior
        return (
            <View style={{ marginVertical: 4 }}>
                <Header />
                {isExpanded && <Content />}
            </View>
        );
    } else {
        // Desktop outline behavior
        return (
            <View style={{ marginVertical: 4 }}>
                <Header />
                {isExpanded && <Content />}
            </View>
        );
    }
}