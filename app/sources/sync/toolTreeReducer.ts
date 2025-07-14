import { ClaudeAgentContent, ToolUseContent, AssistantMessage } from './claudeTypes';

// Tool tree node structure
export interface ToolNode {
    id: string;
    name: string;
    input: any;
    parentId: string | null;
    children: ToolNode[];
    status: 'running' | 'completed' | 'error';
    result?: string;
    error?: boolean;
}

// Tool tree state
export interface ToolTreeState {
    // Map of tool use ID to tool node
    tools: Map<string, ToolNode>;
    // Root level tool IDs (tools with no parent)
    roots: string[];
}

// Actions
export type ToolTreeAction =
    | { type: 'TOOL_STARTED'; toolId: string; name: string; input: any; parentId: string | null }
    | { type: 'TOOL_COMPLETED'; toolId: string; result: string; isError?: boolean }
    | { type: 'CLEAR_TOOLS' };

// Create initial state
export function createToolTreeState(): ToolTreeState {
    return {
        tools: new Map(),
        roots: []
    };
}

// Reducer
export function toolTreeReducer(state: ToolTreeState, action: ToolTreeAction): ToolTreeState {
    switch (action.type) {
        case 'TOOL_STARTED': {
            const { toolId, name, input, parentId } = action;
            
            // Create new tool node
            const node: ToolNode = {
                id: toolId,
                name,
                input,
                parentId,
                children: [],
                status: 'running'
            };
            
            // Clone state
            const newTools = new Map(state.tools);
            const newRoots = [...state.roots];
            
            // Add to tools map
            newTools.set(toolId, node);
            
            // Update parent's children if exists
            if (parentId && newTools.has(parentId)) {
                const parent = { ...newTools.get(parentId)! };
                parent.children = [...parent.children, node];
                newTools.set(parentId, parent);
            } else if (!parentId) {
                // Add to roots if no parent
                newRoots.push(toolId);
            }
            
            return { tools: newTools, roots: newRoots };
        }
        
        case 'TOOL_COMPLETED': {
            const { toolId, result, isError } = action;
            
            const newTools = new Map(state.tools);
            const tool = newTools.get(toolId);
            
            if (tool) {
                const updatedTool = {
                    ...tool,
                    status: isError ? 'error' : 'completed' as const,
                    result,
                    error: isError
                };
                newTools.set(toolId, updatedTool);
                
                // Update parent's reference if exists
                if (tool.parentId) {
                    const parent = newTools.get(tool.parentId);
                    if (parent) {
                        const updatedParent = {
                            ...parent,
                            children: parent.children.map(child => 
                                child.id === toolId ? updatedTool : child
                            )
                        };
                        newTools.set(tool.parentId, updatedParent);
                    }
                }
            }
            
            return { ...state, tools: newTools };
        }
        
        case 'CLEAR_TOOLS': {
            return createToolTreeState();
        }
        
        default:
            return state;
    }
}

// Helper function to extract tool tree from Claude messages
export function extractToolTree(messages: ClaudeAgentContent[]): ToolTreeAction[] {
    const actions: ToolTreeAction[] = [];
    
    for (const message of messages) {
        if (message.type === 'output' && message.data.type === 'assistant') {
            const assistantData = message.data;
            const parentId = assistantData.parent_tool_use_id;
            
            // Extract tool uses from assistant message content
            for (const content of assistantData.message.content) {
                if (content.type === 'tool_use') {
                    actions.push({
                        type: 'TOOL_STARTED',
                        toolId: content.id,
                        name: content.name,
                        input: content.input,
                        parentId
                    });
                }
            }
        } else if (message.type === 'output' && message.data.type === 'user') {
            const userData = message.data;
            
            // Look for tool results in user messages
            for (const content of userData.message.content) {
                if (content.type === 'tool_result') {
                    actions.push({
                        type: 'TOOL_COMPLETED',
                        toolId: content.tool_use_id,
                        result: content.content,
                        isError: content.is_error
                    });
                }
            }
        }
    }
    
    return actions;
}

// Get flat list of all tools
export function getAllTools(state: ToolTreeState): ToolNode[] {
    return Array.from(state.tools.values());
}

// Get tools organized by hierarchy
export function getToolTree(state: ToolTreeState): ToolNode[] {
    return state.roots.map(rootId => state.tools.get(rootId)!);
}

// Get tool by ID
export function getToolById(state: ToolTreeState, toolId: string): ToolNode | undefined {
    return state.tools.get(toolId);
}

// Check if any tools are still running
export function hasRunningTools(state: ToolTreeState): boolean {
    return Array.from(state.tools.values()).some(tool => tool.status === 'running');
}