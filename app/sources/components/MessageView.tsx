import { AssistantContent, Message, MessageContent, Metadata, ToolCall, UserContent } from '@/sync/storageTypes';
import * as React from 'react';
import { View, Text, Pressable} from 'react-native';
import { MarkdownView } from './markdown/MarkdownView';
import { RenderToolV3 } from './blocks/RenderToolCallV3';
import { fakeTool } from './blocks/data-for-nested-toolcall';
// import { RenderToolV1 } from './blocks/RenderToolCallV1';



export const MessageView = (props: { message: Message, metadata: Metadata | null, onPress?: () => void }) => {
    console.log(props.message);
    
    const content = (
        <View
            style={{
                paddingHorizontal: 16,
                paddingVertical: 8,
                flexDirection: 'row'
            }}
        >
            {/*
            {props.message.content && props.message.content.role === 'agent' && (
                <View style={{ height: 4, width: 4, borderRadius: 12, backgroundColor: 'black', opacity: 0.5, marginTop: 9, marginRight: 8 }} />
            )}
            */}
            <View style={{ flexDirection: 'column', flexGrow: 1, flexBasis: 0 }}>
                {props.message.content && props.message.role === 'user' && <UserMessageView message={props.message} metadata={props.metadata} />}
                {props.message.content && props.message.role === 'agent' && <AgentMessageView message={props.message} metadata={props.metadata} />}
                {!props.message.content && <UnknownMessageView />}
            </View>
        </View>
    );

    // If onPress is provided, wrap in Pressable
    if (props.onPress) {
        return (
            <Pressable
                onPress={props.onPress}
                style={({ pressed }) => ({
                    opacity: pressed ? 0.7 : 1,
                    backgroundColor: pressed ? '#f3f4f6' : 'transparent',
                    borderRadius: 8,
                    marginHorizontal: 8,
                })}
            >
                {content}
            </Pressable>
        );
    }

    return content;
}

function UserMessageView(props: { message: UserContent, metadata: Metadata | null }) {

    if (props.message.content.type === 'text') {
        return (
            <View style={{ backgroundColor: '#f0eee6', paddingHorizontal: 12, paddingVertical: 0, borderRadius: 12, marginBottom: 12, alignSelf: 'flex-end' }}>
                <MarkdownView markdown={props.message.content.text} />
            </View>
        )
    }

    return <UnknownMessageView />;
}

function AgentMessageView(props: { message: AssistantContent, metadata: Metadata | null }) {
    if (props.message.content.type === 'text') {
        return (
            <View style={{ borderRadius: 16, alignSelf: 'flex-start', flexGrow: 1, flexBasis: 0, flexDirection: 'column', marginTop: -12, marginBottom: -12, paddingRight: 16 }}>
                <MarkdownView markdown={props.message.content.text} />
            </View>
        )
    }
    if (props.message.content.type === 'tool') {
        //     <View style={{ marginBottom: 16 }}>
        //         {props.message.content.tools.map((tool, index) => (
        //             <ToolDrawer key={index} tool={tool} />
        //         ))}
        //     </View>
        return (
            <View>
                {/*
                <RenderToolV3 tool={fakeTool} metadata={props.metadata} />
                */}
                {props.message.content.tools.map((tool: ToolCall) => (
                    <View>
                        <RenderToolV3 tool={tool} metadata={props.metadata} />
                        {/*
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
                        */}
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