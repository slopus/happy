import * as React from 'react';
import { FlatList, View } from 'react-native';
import { MessageView } from '@/components/MessageView';
import { debugMessages, debugToolCallMessages } from './messages-demo-data';

export default function MessagesDemoScreen() {
    // Combine all demo messages
    const allMessages = [...debugMessages, ...debugToolCallMessages].reverse();

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
                            sessionId="demo-session"
                        />
                    )}
                    style={{ flexGrow: 1, flexBasis: 0 }}
                    contentContainerStyle={{ paddingVertical: 20 }}
                    inverted
                />
            )}
        </View>
    );
}