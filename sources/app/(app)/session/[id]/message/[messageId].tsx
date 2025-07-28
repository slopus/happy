import * as React from 'react';
import { useLocalSearchParams } from "expo-router";
import { Text, View } from "react-native";
import { useMessage } from "@/sync/storage";
import { Deferred } from "@/components/Deferred";
import { ToolFullView } from '@/components/tools/ToolFullView';
import { Message } from '@/sync/typesMessage';

export default React.memo(() => {
    const { id: sessionId, messageId } = useLocalSearchParams<{ id: string; messageId: string }>();
    const message = useMessage(sessionId!, messageId!)!;
    return (
        <Deferred>
            <FullView message={message} />
        </Deferred>
    );
});

function FullView(props: { message: Message }) {
    if (props.message.kind === 'tool-call') {
        return <ToolFullView tool={props.message.tool} />
    }
    if (props.message.kind === 'agent-text') {
        return (
            <Text>

            </Text>
        )
    }
    if (props.message.kind === 'user-text') {
        return (
            <Text>

            </Text>
        )
    }
    return null;
}