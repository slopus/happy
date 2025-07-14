import { useReducer, useEffect } from 'react';
import { 
    toolTreeReducer, 
    createToolTreeState, 
    extractToolTree,
    ToolTreeState,
    ToolNode,
    getAllTools,
    getToolTree,
    hasRunningTools
} from './toolTreeReducer';
import { ClaudeAgentContent } from './claudeTypes';

export interface UseToolTreeResult {
    state: ToolTreeState;
    allTools: ToolNode[];
    toolTree: ToolNode[];
    hasRunning: boolean;
    clearTools: () => void;
    processMessages: (messages: ClaudeAgentContent[]) => void;
}

export function useToolTree(): UseToolTreeResult {
    const [state, dispatch] = useReducer(toolTreeReducer, null, createToolTreeState);
    
    const allTools = getAllTools(state);
    const toolTree = getToolTree(state);
    const hasRunning = hasRunningTools(state);
    
    const clearTools = () => {
        dispatch({ type: 'CLEAR_TOOLS' });
    };
    
    const processMessages = (messages: ClaudeAgentContent[]) => {
        const actions = extractToolTree(messages);
        actions.forEach(action => dispatch(action));
    };
    
    return {
        state,
        allTools,
        toolTree,
        hasRunning,
        clearTools,
        processMessages
    };
}