import * as React from 'react';
import { FlatList, View } from 'react-native';
import { MessageView } from '@/components/MessageView';
import { debugMessages, debugToolCallMessages } from './messages-demo-data';
import { Message } from '@/sync/typesMessage';
import { useDemoMessages } from '@/hooks/useDemoMessages';
import { useMessage } from '@/sync/storage';

export default function MessagesDemoScreen() {
    // Combine all demo messages
    const allMessages = [...debugMessages, ...debugToolCallMessages];
    
    // Load demo messages into session storage
    const sessionId = useDemoMessages(allMessages);

    return (
        <View style={{ flex: 1, backgroundColor: '#fff' }}>
            {allMessages.length > 0 && (
                <FlatList
                    data={allMessages}
                    keyExtractor={(item) => item.id}
                    renderItem={({ item }) => (
                        <MessageView 
                            message={item} 
                            metadata={null}
                            sessionId={sessionId}
                            getMessageById={(id: string): Message | null => {
                                return allMessages.find((m)=>m.id === id) || null;
                            }}
                        />
                    )}
                    style={{ flexGrow: 1, flexBasis: 0 }}
                    contentContainerStyle={{ paddingVertical: 20 }}
                />
            )}
        </View>
    );
}