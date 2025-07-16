import { type ToolCall } from '@/sync/storageTypes';
import { Metadata } from '@/sync/storageTypes';
import { resolvePath } from '@/utils/pathUtils';
import * as React from 'react';
import { View, Text, } from 'react-native';


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