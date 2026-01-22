import * as React from 'react';
import { FlatList, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { MessageView } from '@/components/MessageView';
import { debugMessages } from './messages-demo-data';
import { Message } from '@/sync/typesMessage';
import { useDemoMessages } from '@/hooks/useDemoMessages';

export default React.memo(function MessagesDemoScreen() {
    // Combine all demo messages
    const allMessages = [...debugMessages];

    // Load demo messages into session storage
    const sessionId = useDemoMessages(allMessages);

    return (
        <View style={styles.container}>
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
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
}));