import React, { useState } from 'react';
import { View, Text, TouchableOpacity, useWindowDimensions, Modal, ScrollView } from 'react-native';
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
    const [isModalVisible, setIsModalVisible] = useState(false);
    const { width } = useWindowDimensions();
    const isNarrowScreen = width < 700;
    
    // Now load the actual tool call message objects now that the component has mounted.
    console.log('ToolCallGroupBlock - messageIds:', message.messageIds);
    console.log('ToolCallGroupBlock - message.id:', message.id);
    
    const toolCallMessages = message.messageIds
        .map(id => {
            const foundMessage = getMessageById(id);
            console.log(`ToolCallGroupBlock - Looking for message ${id}:`, foundMessage);
            return foundMessage;
        })
        .filter((msg): msg is ToolCallMessage => msg !== null && msg.kind === 'tool-call');

    console.log('ToolCallGroupBlock - Final toolCallMessages:', toolCallMessages);
    const toolCount = toolCallMessages.length;

    // Get only the 3 most recent tool calls for the main view
    const recentToolCalls = toolCallMessages.slice(-3);

    const openModal = () => {
        setIsModalVisible(true);
    };

    const closeModal = () => {
        setIsModalVisible(false);
    };

    // Header component - stays on default white surface
    const Header = () => (
        <TouchableOpacity
            onPress={openModal}
            style={{
                paddingHorizontal: 16,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingVertical: 12,
                borderRadius: isNarrowScreen ? 0 : 8,
                borderWidth: isNarrowScreen ? 0 : 1,
                borderColor: '#e0e0e0',
                borderTopLeftRadius: 8,
                borderTopRightRadius: 8,
                borderBottomLeftRadius: 8,
                borderBottomRightRadius: 8,
            }}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8,  }}>
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
                <Text style={{ fontSize: 11, color: '#999', fontFamily: 'monospace' }}>
                    {message.id}
                </Text>
            </View>
            <Text style={{ fontSize: 16, color: '#666' }}>
                {toolCount > 3 ? `View all (${toolCount})` : ''}
            </Text>
        </TouchableOpacity>
    );

    // Content component - shows only the 3 most recent tool calls with sunken appearance
    const Content = () => (
        <View
            style={{
                borderWidth: isNarrowScreen ? 0 : 1,
                borderColor: '#e0e0e0',
                backgroundColor: '#faf9f5',
                paddingTop: 4,
                paddingBottom: 4,
                overflow: 'hidden',

            }}
        >
            {/* Top shadow caster */}
            <View
                style={{
                    position: 'absolute',
                    top: -1,
                    left: -8,
                    right: -8,
                    height: 1,
                    backgroundColor: '#000',
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 2 },
                    shadowOpacity: 0.4,
                    shadowRadius: 4,
                    zIndex: 2,
                }}
            />
            {/* Bottom shadow caster */}
            <View
                style={{
                    position: 'absolute',
                    bottom: -1,
                    left: -8,
                    right: -8,
                    height: 1,
                    backgroundColor: '#000',
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 2 },
                    shadowOpacity: 1,
                    shadowRadius: 8,
                    elevation: 4,
                    zIndex: 2,
                }}
            />
            <View style={{ zIndex: 1 }}>
                {recentToolCalls.map((toolMsg, index) => (
                    <View key={toolMsg.id}>
                        {toolMsg.tools.map((tool, toolIndex) => (
                            <View
                                key={toolIndex}
                                style={{
                                    backgroundColor: 'transparent',
                                    marginHorizontal: 8,
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
            {toolCount > 3 && (
                <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                    <Text style={{ fontSize: 12, color: '#666', textAlign: 'center' }}>
                        Showing 3 of {toolCount} tools.
                    </Text>
                </View>
            )}
            </View>
        </View>
    );

    // Modal component for viewing all tool calls
    const ModalContent = () => (
        <Modal
            visible={isModalVisible}
            animationType="slide"
            presentationStyle="pageSheet"
            onRequestClose={closeModal}
        >
            <View style={{ flex: 1, backgroundColor: '#ffffff' }}>
                <View style={{ 
                    flexDirection: 'row', 
                    alignItems: 'center', 
                    justifyContent: 'space-between',
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderBottomWidth: 1,
                    borderBottomColor: '#e0e0e0',
                    backgroundColor: '#f8f9fa'
                }}>
                    <Text style={{ fontSize: 18, fontWeight: '600', color: '#333' }}>
                        All Tool Calls ({toolCount})
                    </Text>
                    <TouchableOpacity onPress={closeModal}>
                        <Text style={{ fontSize: 16, color: '#007AFF' }}>Done</Text>
                    </TouchableOpacity>
                </View>
                <ScrollView style={{ flex: 1 }}>
                    <View style={{ padding: 16 }}>
                        {toolCallMessages.map((toolMsg, index) => (
                            <View key={toolMsg.id} style={{ marginBottom: 16 }}>
                                <Text style={{ 
                                    fontSize: 12, 
                                    color: '#666', 
                                    marginBottom: 8,
                                    fontFamily: 'monospace'
                                }}>
                                    Message: {toolMsg.id}
                                </Text>
                                {toolMsg.tools.map((tool, toolIndex) => (
                                    <View
                                        key={toolIndex}
                                        style={{
                                            borderWidth: 1,
                                            borderColor: '#e0e0e0',
                                            borderRadius: 8,
                                            backgroundColor: '#ffffff',
                                            marginBottom: 8,
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
                </ScrollView>
            </View>
        </Modal>
    );

    if (isNarrowScreen) {
        return (
            <View style={{ marginVertical: 4}}>
                <Header />
                <Content />
                <ModalContent />
            </View>
        );
    } else {
        return (
            <View style={{ marginVertical: 4, borderWidth: 1, borderColor: '#e0e0e0', borderRadius: 8, paddingHorizontal: 16 }}>
                <Header />
                <Content />
                <ModalContent />
            </View>
        );
    }
}