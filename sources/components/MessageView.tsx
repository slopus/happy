import { ReducedMessage } from '@/sync/reducer';
import { SyncMessage } from '@/sync/SyncSession';
import { HumanContent } from '@/sync/types';
import * as React from 'react';
import { View, Text } from 'react-native';
import { MarkdownView } from './markdown/MarkdownView';

export const MessageView = (props: { message: SyncMessage }) => {
    return (
        <View
            style={{
                paddingHorizontal: 16,
                paddingVertical: 4
            }}
        >
            {props.message.content && props.message.content.role === 'user' && <UserMessageView message={props.message.content} />}
            {props.message.content && props.message.content.role === 'agent' && <AgentMessageView message={props.message.content} />}
            {!props.message.content && <UnknownMessageView />}
        </View>
    )
}

function UserMessageView(props: { message: HumanContent }) {

    if (props.message.content.type === 'text') {
        return (
            <View style={{ backgroundColor: 'black', padding: 16, borderRadius: 16, alignSelf: 'flex-end' }}>
                <Text style={{ color: 'white', fontSize: 16 }}>{props.message.content.text}</Text>
            </View>
        )
    }

    return <UnknownMessageView />;
}

function AgentMessageView(props: { message: ReducedMessage }) {
    if (props.message.content.type === 'text') {
        return (
            <View style={{ backgroundColor: 'white', borderRadius: 16, alignSelf: 'flex-start' }}>
                <MarkdownView markdown={props.message.content.text} />
            </View>
        )
    }
    if (props.message.content.type === 'tool') {
        return (
            <View>
                {props.message.content.tools.map((tool) => (
                    <View>
                        <Text style={{ color: 'black', opacity: 0.9 }}>{tool.name} ({JSON.stringify(tool.arguments)})</Text>
                        {tool.children.map((child) => (
                            <View style={{ paddingLeft: 16 }}>
                                <Text style={{ color: 'black', opacity: 0.9 }}>{child.name} ({JSON.stringify(tool.arguments)})</Text>
                            </View>
                        ))}
                    </View>
                ))}
            </View>
        )
    }
    return (
        <View>
            <Text>{JSON.stringify(props.message.content, null, 2)}</Text>
        </View>
    )
}

function UnknownMessageView() {
    return (
        <View>
            <Text>Unknown message, please update the app to the latest version.</Text>
        </View>
    )
}