import { type ToolCall } from '@/sync/reducer';
import { Metadata } from '@/sync/types';
import { resolvePath } from '@/utils/pathUtils';
import * as React from 'react';
import { View, Text, TouchableOpacity, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// Design note: I don't like the way this component has to separate the header
// and the content. This was driven by the need to show nested tool calls, where
// the nested tool calls have a different container design. And the header will
// change what it displays based on the drawer being open or not.
// 
// Possibley this could be refactored to have a single component for the drawer
// that displays the lines or zero vertical lines depending on a flag. And then
// the normal expanding portion is rendered by a standalone component, one for
// each kind of specialized tool call, plus one generic tool call component.

// Component for rendering tool header/summary
export function ToolHeader(props: { tool: ToolCall, metadata: Metadata | null }) {
    const getDisplayText = () => {
        switch (props.tool.name) {
            case 'Read':
                const filePath = props.tool.arguments?.file_path;
                if (filePath && typeof filePath === 'string') {
                    const resolvedPath = resolvePath(filePath, props.metadata);
                    return `Read ${resolvedPath}`;
                }
                return 'Read file';
            
            case 'LS':
                const lsPath = props.tool.arguments?.path;
                if (lsPath) {
                    return `List ${resolvePath(lsPath, props.metadata)}`;
                }
                return 'List directory';
            
            case 'TodoWrite':
                const todos = props.tool.arguments?.todos as any[];
                if (todos && todos.length > 0) {
                    return `TODO (${todos.length} items)`;
                }
                return 'TODO';
            
            case 'Task':
                const description = props.tool.arguments?.description;
                if (description && typeof description === 'string') {
                    return `Task: ${description}`;
                }
                return 'Task';
            
            case 'EditFile':
                const editPath = props.tool.arguments?.target_file || props.tool.arguments?.file_path;
                if (editPath && typeof editPath === 'string') {
                    const resolvedEditPath = resolvePath(editPath, props.metadata);
                    return `Edit ${resolvedEditPath}`;
                }
                return 'Edit file';
            
            case 'CreateFile':
                const createPath = props.tool.arguments?.target_file || props.tool.arguments?.file_path;
                if (createPath && typeof createPath === 'string') {
                    const resolvedCreatePath = resolvePath(createPath, props.metadata);
                    return `Create ${resolvedCreatePath}`;
                }
                return 'Create file';
            
            case 'RunCommand':
                const command = props.tool.arguments?.command;
                if (command && typeof command === 'string') {
                    return `Run: ${command}`;
                }
                return 'Run command';
            
            default:
                return props.tool.name;
        }
    };

    return (
        <Text style={{
            fontSize: 14,
            color: '#374151',
            fontWeight: '500',
            flex: 1
        }} numberOfLines={1}>
            {getDisplayText()}
        </Text>
    );
}

// Component for rendering tool content in the drawer
export function ToolContent(props: { tool: ToolCall, metadata: Metadata | null }) {
    const renderCustomContent = () => {
        switch (props.tool.name) {
            case 'Read':
                const filePath = props.tool.arguments?.file_path;
                if (filePath && typeof filePath === 'string') {
                    const resolvedPath = resolvePath(filePath, props.metadata);
                    return (
                        <View style={{ marginBottom: 8 }}>
                            <Text style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
                                File Path:
                            </Text>
                            <Text style={{ 
                                fontSize: 12, 
                                color: '#1f2937', 
                                fontFamily: 'monospace',
                                backgroundColor: '#f3f4f6',
                                padding: 6,
                                borderRadius: 4
                            }}>
                                {resolvedPath}
                            </Text>
                        </View>
                    );
                }
                break;
            
            case 'LS':
                const lsPath = props.tool.arguments?.path;
                if (lsPath) {
                    return (
                        <View style={{ marginBottom: 8 }}>
                            <Text style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
                                Directory:
                            </Text>
                            <Text style={{ 
                                fontSize: 12, 
                                color: '#1f2937', 
                                fontFamily: 'monospace',
                                backgroundColor: '#f3f4f6',
                                padding: 6,
                                borderRadius: 4
                            }}>
                                {resolvePath(lsPath, props.metadata)}
                            </Text>
                        </View>
                    );
                }
                break;
            
            case 'TodoWrite':
                const todos = props.tool.arguments?.todos as { id: string, content: string, status: 'in_progress' | 'pending' | 'completed' | 'cancelled' }[];
                if (todos && todos.length > 0) {
                    return (
                        <View style={{ marginBottom: 8 }}>
                            {todos.map((todo) => (
                                <View key={todo.id} style={{ 
                                    flexDirection: 'row', 
                                    alignItems: 'center', 
                                    marginBottom: 4,
                                    backgroundColor: '#f9fafb',
                                    padding: 6,
                                    borderRadius: 4
                                }}>
                                    <View style={{
                                        width: 8,
                                        height: 8,
                                        borderRadius: 4,
                                        backgroundColor: todo.status === 'completed' ? '#10b981' : 
                                                      todo.status === 'in_progress' ? '#f59e0b' : 
                                                      todo.status === 'cancelled' ? '#ef4444' : '#6b7280',
                                        marginRight: 8
                                    }} />
                                    <Text style={{ 
                                        fontSize: 12, 
                                        color: '#374151',
                                        flex: 1,
                                        textDecorationLine: todo.status === 'completed' ? 'line-through' : 'none'
                                    }}>
                                        {todo.content}
                                    </Text>
                                </View>
                            ))}
                        </View>
                    );
                }
                break;
            
            case 'Task':
                const description = props.tool.arguments?.description;
                if (description && typeof description === 'string') {
                    return (
                        <View style={{ marginBottom: 8 }}>
                            <Text style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
                                Description:
                            </Text>
                            <Text style={{ 
                                fontSize: 12, 
                                color: '#374151',
                                backgroundColor: '#f3f4f6',
                                padding: 6,
                                borderRadius: 4
                            }}>
                                {description}
                            </Text>
                        </View>
                    );
                }
                break;
            
            case 'EditFile':
            case 'CreateFile':
                const targetFile = props.tool.arguments?.target_file || props.tool.arguments?.file_path;
                if (targetFile && typeof targetFile === 'string') {
                    const resolvedTarget = resolvePath(targetFile, props.metadata);
                    return (
                        <View style={{ marginBottom: 8 }}>
                            <Text style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
                                Target File:
                            </Text>
                            <Text style={{ 
                                fontSize: 12, 
                                color: '#1f2937', 
                                fontFamily: 'monospace',
                                backgroundColor: '#f3f4f6',
                                padding: 6,
                                borderRadius: 4
                            }}>
                                {resolvedTarget}
                            </Text>
                        </View>
                    );
                }
                break;
            
            case 'RunCommand':
                const command = props.tool.arguments?.command;
                if (command && typeof command === 'string') {
                    return (
                        <View style={{ marginBottom: 8 }}>
                            <Text style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
                                Command:
                            </Text>
                            <Text style={{ 
                                fontSize: 12, 
                                fontFamily: 'monospace',
                                backgroundColor: '#1f2937',
                                color: '#f9fafb',
                                padding: 6,
                                borderRadius: 4
                            }}>
                                {command}
                            </Text>
                        </View>
                    );
                }
                break;
        }
        
        return null;
    };

    const customContent = renderCustomContent();
    const hasArguments = props.tool.arguments && Object.keys(props.tool.arguments).length > 0;

    return (
        <View>
            {/* Custom content for specific tools */}
            {customContent}
            
            {/* Raw arguments (only show if no custom content or for debugging) */}
            {!customContent && hasArguments && (
                <View style={{
                    backgroundColor: '#f9fafb',
                    padding: 8,
                    borderRadius: 6,
                    marginBottom: 0
                }}>
                    <Text style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
                        {customContent ? 'Raw Arguments:' : 'Arguments:'}
                    </Text>
                    <Text style={{ fontSize: 12, color: '#374151', fontFamily: 'monospace' }}>
                        {JSON.stringify(props.tool.arguments, null, 2)}
                    </Text>
                </View>
            )}
        </View>
    );
}

// A tool drawer can show nested tool calls. This happens most often with Task
// tool call, which is a sub agent execution. I have not seen any other tool
// calls other than Task with their own children.

// Tools that are typically leaf nodes and don't have children
const LEAF_TOOLS = new Set(['TodoWrite', 'Read', 'LS', 'EditFile', 'CreateFile', 'RunCommand', 'WriteFile']);

export function RenderToolV3(props: { tool: ToolCall, metadata: Metadata | null }) {
    const [isOpen, setIsOpen] = React.useState(false);
    const [animationValue] = React.useState(new Animated.Value(0));

    React.useEffect(() => {
        Animated.timing(animationValue, {
            toValue: isOpen ? 1 : 0,
            duration: 300,
            useNativeDriver: false,
        }).start();
    }, [isOpen]);

    const getStateColor = (state: string) => {
        switch (state) {
            case 'running': return '#f59e0b';
            case 'completed': return '#10b981';
            case 'error': return '#ef4444';
            default: return '#6b7280';
        }
    };

    const getStateIcon = (state: string) => {
        switch (state) {
            case 'running': return 'time-outline';
            case 'completed': return 'checkmark-circle-outline';
            case 'error': return 'close-circle-outline';
            default: return 'ellipse-outline';
        }
    };

    const hasChildren = props.tool.children && props.tool.children.length > 0;
    const isLeafTool = LEAF_TOOLS.has(props.tool.name);
    
    // Special case for TODO tools - render inline without drawer
    if (props.tool.name === 'TodoWrite') {
        return (
            <View style={{
                borderWidth: 1,
                borderColor: '#d1d5db',
                borderRadius: 8,
                backgroundColor: 'white',
                padding: 12
            }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                    <Ionicons 
                        name={getStateIcon(props.tool.state)} 
                        size={16} 
                        color={getStateColor(props.tool.state)} 
                        style={{ marginRight: 8 }} 
                    />
                    <ToolHeader tool={props.tool} metadata={props.metadata} />
                    <View style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: getStateColor(props.tool.state),
                        marginLeft: 8
                    }} />
                </View>
                <ToolContent tool={props.tool} metadata={props.metadata} />
            </View>
        );
    }
    
    // For other leaf tools, show a simpler non-expandable version
    if (isLeafTool && !hasChildren) {
        return (
            <View style={{
                borderWidth: 1,
                borderColor: '#d1d5db',
                borderRadius: 8,
                marginBottom: 8,
                backgroundColor: 'white',
                overflow: 'hidden'
            }}>
                <View style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingHorizontal: 12,
                    paddingVertical: 12,
                    minHeight: 48
                }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                        <Ionicons 
                            name={getStateIcon(props.tool.state)} 
                            size={16} 
                            color={getStateColor(props.tool.state)} 
                            style={{ marginRight: 8 }} 
                        />
                        <ToolHeader tool={props.tool} metadata={props.metadata} />
                    </View>
                    <View style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: getStateColor(props.tool.state)
                    }} />
                </View>
            </View>
        );
    }

    return (
        <View style={{
            borderWidth: 1,
            borderColor: '#d1d5db',
            borderRadius: 8,
            marginBottom: 8,
            backgroundColor: 'white',
            overflow: 'hidden'
        }}>
            {/* Main tool header */}
            <TouchableOpacity
                onPress={() => setIsOpen(!isOpen)}
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingHorizontal: 12,
                    paddingVertical: 12,
                    minHeight: 48
                }}
            >
                <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                    <Ionicons 
                        name={getStateIcon(props.tool.state)} 
                        size={16} 
                        color={getStateColor(props.tool.state)} 
                        style={{ marginRight: 8 }} 
                    />
                    <ToolHeader tool={props.tool} metadata={props.metadata} />
                </View>

                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: getStateColor(props.tool.state),
                        marginRight: 8
                    }} />
                    <Ionicons 
                        name="chevron-down" 
                        size={12} 
                        color="#6b7280"
                        style={{
                            transform: [{ rotate: isOpen ? '180deg' : '0deg' }]
                        }}
                    />
                </View>
            </TouchableOpacity>

            {/* Expandable content */}
            <Animated.View style={{
                height: animationValue.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, isOpen ? 'auto' : 0] as any
                }),
                opacity: animationValue
            }}>
                {isOpen && (
                    <View style={{ paddingHorizontal: 12, paddingBottom: 12 }}>
                        {/* Tool content */}
                        <View style={{ marginBottom: hasChildren ? 12 : 0 }}>
                            <ToolContent tool={props.tool} metadata={props.metadata} />
                        </View>

                        {/* Child tools */}
                        {hasChildren && (
                            <View>
                                <Text style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
                                    Nested Tools:
                                </Text>
                                {props.tool.children.map((child, index) => (
                                    <ChildToolDrawer 
                                        key={index} 
                                        tool={child} 
                                        metadata={props.metadata}
                                        isLast={index === props.tool.children.length - 1}
                                    />
                                ))}
                            </View>
                        )}
                    </View>
                )}
            </Animated.View>
        </View>
    );
}

function ChildToolDrawer(props: { tool: ToolCall; metadata: Metadata | null; isLast: boolean }) {
    const [isOpen, setIsOpen] = React.useState(false);
    const [animationValue] = React.useState(new Animated.Value(0));

    React.useEffect(() => {
        Animated.timing(animationValue, {
            toValue: isOpen ? 1 : 0,
            duration: 300,
            useNativeDriver: false,
        }).start();
    }, [isOpen]);

    const getStateColor = (state: string) => {
        switch (state) {
            case 'running': return '#f59e0b';
            case 'completed': return '#10b981';
            case 'error': return '#ef4444';
            default: return '#6b7280';
        }
    };

    const getStateIcon = (state: string) => {
        switch (state) {
            case 'running': return 'time-outline';
            case 'completed': return 'checkmark-circle-outline';
            case 'error': return 'close-circle-outline';
            default: return 'ellipse-outline';
        }
    };

    return (
        <View style={{ flexDirection: 'row', marginBottom: props.isLast ? 0 : 8 }}>
            {/* Timeline connector */}
            <View style={{
                width: 24,
                alignItems: 'center',
                paddingTop: 4
            }}>
                {/* Connecting line from top */}
                <View style={{
                    width: 1,
                    height: 8,
                    backgroundColor: '#d1d5db'
                }} />
                
                {/* Dot indicator */}
                <View style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: getStateColor(props.tool.state),
                    marginVertical: 2
                }} />
                
                {/* Connecting line to bottom (if not last) */}
                {!props.isLast && (
                    <View style={{
                        width: 1,
                        flex: 1,
                        backgroundColor: '#d1d5db',
                        minHeight: 16
                    }} />
                )}
            </View>

            {/* Content */}
            <View style={{ flex: 1 }}>
                <TouchableOpacity
                    onPress={() => setIsOpen(!isOpen)}
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingVertical: 6,
                        paddingRight: 8
                    }}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                        <Ionicons 
                            name={getStateIcon(props.tool.state)} 
                            size={14} 
                            color={getStateColor(props.tool.state)} 
                            style={{ marginRight: 6 }} 
                        />
                        <Text style={{
                            fontSize: 13,
                            color: '#4b5563',
                            flex: 1
                        }} numberOfLines={1}>
                            {props.tool.name}
                        </Text>
                    </View>

                    <Ionicons 
                        name="chevron-down" 
                        size={10} 
                        color="#9ca3af"
                        style={{
                            transform: [{ rotate: isOpen ? '180deg' : '0deg' }]
                        }}
                    />
                </TouchableOpacity>

                {/* Expandable content for child */}
                <Animated.View style={{
                    height: animationValue.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, isOpen ? 'auto' : 0] as any
                    }),
                    opacity: animationValue
                }}>
                    {isOpen && (
                        <View style={{
                            backgroundColor: '#f3f4f6',
                            padding: 8,
                            borderRadius: 4,
                            marginBottom: 4
                        }}>
                            <ToolContent tool={props.tool} metadata={props.metadata} />
                        </View>
                    )}
                </Animated.View>
            </View>
        </View>
    );
}

