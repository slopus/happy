import { ReducedMessage, ToolCall } from '@/sync/reducer';
import { SyncMessage } from '@/sync/SyncSession';
import { HumanContent, Metadata } from '@/sync/types';
import { resolvePath } from '@/utils/pathUtils';
import * as React from 'react';
import { View, Text } from 'react-native';
import { MarkdownView } from './markdown/MarkdownView';

export const MessageView = (props: { message: SyncMessage, metadata: Metadata | null }) => {
    console.log(props.message);
    return (
        <View
            style={{
                paddingHorizontal: 16,
                paddingVertical: 8,
                flexDirection: 'row'
            }}
        >
            {props.message.content && props.message.content.role === 'agent' && (
                <View style={{ height: 4, width: 4, borderRadius: 12, backgroundColor: 'black', opacity: 0.5, marginTop: 9, marginRight: 8 }} />
            )}
            <View style={{ flexDirection: 'column', flexGrow: 1, flexBasis: 0 }}>
                {props.message.content && props.message.content.role === 'user' && <UserMessageView message={props.message.content} metadata={props.metadata} />}
                {props.message.content && props.message.content.role === 'agent' && <AgentMessageView message={props.message.content} metadata={props.metadata} />}
                {!props.message.content && <UnknownMessageView />}
            </View>
        </View>
    )
}

function UserMessageView(props: { message: HumanContent, metadata: Metadata | null }) {

    if (props.message.content.type === 'text') {
        return (
            <View style={{ backgroundColor: '#f0eee6', paddingHorizontal: 12, paddingVertical: 0, borderRadius: 12, marginBottom: 12, alignSelf: 'flex-end' }}>
                <MarkdownView markdown={props.message.content.text} />
            </View>
        )
    }

    return <UnknownMessageView />;
}

function AgentMessageView(props: { message: ReducedMessage, metadata: Metadata | null }) {
    if (props.message.content.type === 'text') {
        return (
            <View style={{ borderRadius: 16, alignSelf: 'flex-start', flexGrow: 1, flexBasis: 0, flexDirection: 'column', marginTop: -12, marginBottom: -12, paddingRight: 16 }}>
                <MarkdownView markdown={props.message.content.text} />
            </View>
        )
    }
    if (props.message.content.type === 'tool') {
        return (
            <View>
                {props.message.content.tools.map((tool) => (
                    <View>
                        <RenderTool tool={tool} metadata={props.metadata} />
                        {tool.children.length <= 3 && (
                            <View style={{ paddingLeft: 16 }}>
                                {tool.children.map((child) => (
                                    <RenderTool tool={child} metadata={props.metadata} />
                                ))}
                            </View>
                        )}
                        {tool.children.length > 3 && (
                            <View style={{ paddingLeft: 16 }}>
                                <RenderTool tool={tool.children[tool.children.length - 2]} metadata={props.metadata} />
                                <RenderTool tool={tool.children[tool.children.length - 1]} metadata={props.metadata} />
                                <Text style={{ color: 'black', opacity: 0.9 }}> + {tool.children.length - 2} more</Text>
                            </View>
                        )}
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

function RenderTool(props: { tool: ToolCall, metadata: Metadata | null }) {
    if (props.tool.name === 'Read') {
        // Example: If the tool has a file_path argument, resolve it relative to the root
        const filePath = props.tool.arguments?.file_path;
        if (filePath && typeof filePath === 'string') {
            const resolvedPath = resolvePath(filePath, props.metadata);
            return (
                <View>
                    <Text style={{ fontFamily: 'SpaceMono' }}><Text style={{ color: 'blue' }}>{props.tool.name}</Text> <Text style={{ opacity: 0.5 }}>{resolvedPath}</Text></Text>
                </View>
            );
        }
    }
    if (props.tool.name === 'LS') {
        return (
            <View>
                <Text style={{ fontFamily: 'SpaceMono' }}><Text style={{ color: 'blue' }}>LS</Text> <Text style={{ opacity: 0.5 }}>{resolvePath(props.tool.arguments.path, props.metadata)}</Text></Text>
            </View>
        )
    }
    if (props.tool.name === 'TodoWrite') {
        return (
            <View>
                <Text style={{ color: 'blue' }}>TODO</Text>
                {(props.tool.arguments.todos as { id: string, content: string, status: 'in_progress' | 'pending' | 'done' }[])
                    .map((todo) => (
                        <Text key={todo.id} style={{ color: todo.status === 'in_progress' ? 'green' : 'grey', textDecorationLine: todo.status === 'done' ? 'line-through' : 'none' }}>{todo.id}: {todo.content}</Text>
                    ))}
            </View>
        )
    }
    if (props.tool.name === 'Task') {
        return (
            <View>
                <Text style={{ fontFamily: 'SpaceMono' }}><Text style={{ color: 'blue' }}>Task</Text> <Text style={{ opacity: 0.5 }}>{props.tool.arguments.description}</Text></Text>
            </View>
        )
    }
    return (
        <View>
            <Text>{props.tool.name} ({JSON.stringify(props.tool.arguments)})</Text>
        </View>
    )
}