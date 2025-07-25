import * as React from 'react';
import { useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { useMessage } from "@/sync/storage";
import { MessageDetailModalComponent } from "@/components/message-detail-modals/_all";
import { Deferred } from "@/components/Deferred";

export default React.memo(() => {
    const { id: sessionId, messageId } = useLocalSearchParams<{ id: string; messageId: string }>();
    const message = useMessage(sessionId!, messageId!);

    return (
        <Deferred>
            <MessageDetailModalComponent message={message} sessionId={sessionId} />
        </Deferred>
    );
});
