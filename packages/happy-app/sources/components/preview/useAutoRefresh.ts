import * as React from 'react';
import { useSessionMessages } from '@/sync/storage';
import { AutoRefreshManager } from './autoRefreshClient';
import type { Message } from '@/sync/typesMessage';

type RefreshCallback = (type: 'css' | 'full') => void;

/**
 * Hook that watches session messages for tool-call completions and triggers
 * auto-refresh of the Preview Panel WebView/iframe.
 *
 * It detects Edit, Write, and Bash tool calls that modify files and debounces
 * them into a single refresh event.
 */
export function useAutoRefresh(sessionId: string, onRefresh: RefreshCallback) {
    const { messages } = useSessionMessages(sessionId);
    const managerRef = React.useRef<AutoRefreshManager | null>(null);
    const prevCountRef = React.useRef(0);

    // Create manager once
    React.useEffect(() => {
        managerRef.current = new AutoRefreshManager(onRefresh);
        return () => {
            managerRef.current?.destroy();
            managerRef.current = null;
        };
    }, [onRefresh]);

    // Watch for new tool-call messages
    React.useEffect(() => {
        if (!messages || messages.length === 0) return;
        if (messages.length <= prevCountRef.current) {
            prevCountRef.current = messages.length;
            return;
        }

        // Check new messages only
        const newMessages = messages.slice(prevCountRef.current);
        prevCountRef.current = messages.length;

        for (const msg of newMessages) {
            if (msg.kind === 'tool-call' && msg.tool) {
                const toolName = msg.tool.name || '';
                const filePath = msg.tool.input?.file_path || msg.tool.input?.filePath || undefined;
                const command = msg.tool.input?.command || undefined;
                managerRef.current?.handleToolCallEnd(toolName, command, filePath);
            }
        }
    }, [messages]);
}
