import * as React from 'react';
import { useLocalSearchParams, Stack } from "expo-router";
import { Text, View } from "react-native";
import { useMessage } from "@/sync/storage";
import { Deferred } from "@/components/Deferred";
import { ToolFullView } from '@/components/tools/ToolFullView';
import { ToolHeader } from '@/components/tools/ToolHeader';
import { ToolStatusIndicator } from '@/components/tools/ToolStatusIndicator';
import { Message } from '@/sync/typesMessage';

export default React.memo(() => {
    const { id: sessionId, messageId } = useLocalSearchParams<{ id: string; messageId: string }>();
    const message = useMessage(sessionId!, messageId!)!;
    
    // Configure header for tool messages
    React.useLayoutEffect(() => {
        if (message && message.kind === 'tool-call' && message.tool) {
            // Header is configured in the Stack.Screen options
        }
    }, [message]);
    
    return (
        <>
            {message && message.kind === 'tool-call' && message.tool && (
                <Stack.Screen
                    options={{
                        headerTitle: () => <ToolHeader tool={message.tool} />,
                        headerRight: () => <ToolStatusIndicator tool={message.tool} />,
                    }}
                />
            )}
            <Deferred>
                <FullView message={message} />
            </Deferred>
        </>
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