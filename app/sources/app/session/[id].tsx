import { Text } from "@/components/Themed";
import { syncSessions } from "@/sync/SyncSessions";
import { useSyncSession } from "@/sync/useSyncSession";
import { useRoute } from "@react-navigation/native";
import { useState } from "react";
import { ScrollView, TextInput, View } from "react-native";

export default function Session() {
    const route = useRoute();
    const sessionId = (route.params! as any).id as string;
    const session = useSyncSession(sessionId);

    const [message, setMessage] = useState('');

    return (
        <View style={{ flex: 1, paddingBottom: 48 }}>
            <ScrollView style={{ flex: 1, padding: 16 }}>
                {session.messages.map((message) => (
                    <View key={message.id}>
                        <Text>{JSON.stringify(message)}</Text>
                    </View>
                ))}
            </ScrollView>
            <TextInput
                style={{ height: 40, borderColor: 'gray', borderWidth: 1 }}
                value={message}
                onChangeText={setMessage}
                onSubmitEditing={() => {
                    syncSessions.getSession(sessionId).sendMessage(message);
                    setMessage('');
                }}
            />
        </View>
    )
}