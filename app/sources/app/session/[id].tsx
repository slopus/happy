import { syncSessions } from "@/sync/SyncSessions";
import { useSyncSession } from "@/sync/useSyncSession";
import { useRoute } from "@react-navigation/native";
import { useState } from "react";
import { FlatList, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MessageView } from "@/components/MessageView";

export default function Session() {
    const safeArea = useSafeAreaInsets();
    const route = useRoute();
    const sessionId = (route.params! as any).id as string;
    const session = useSyncSession(sessionId);
    const [message, setMessage] = useState('');
    return (
        <KeyboardAvoidingView
            behavior="translate-with-padding"
            keyboardVerticalOffset={56}
            style={{ flex: 1, paddingBottom: safeArea.bottom }}
        >
            <FlatList
                data={session.messages}
                inverted={true}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => <MessageView message={item} />}
                ListFooterComponent={() => <View style={{ height: 100 }} />}
                ListHeaderComponent={() => <View style={{ height: 32 }} />}
            />
            <TextInput
                style={{ height: 40, borderColor: 'gray', borderWidth: 1, marginBottom: 16, marginHorizontal: 16 }}
                value={message}
                onChangeText={setMessage}
                onSubmitEditing={() => {
                    syncSessions.getSession(sessionId).sendMessage(message);
                    setMessage('');
                }}
            />
        </KeyboardAvoidingView>
    )
}