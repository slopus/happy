import { Session } from '@/sync/storageTypes';
import { Message } from '@/sync/typesMessage';
import { getSessionName } from '@/utils/sessionUtils';

export function sessionToRealtimePrompt(session: Session, messages: Message[]): string {
    const sessionName = getSessionName(session);
    const lines: string[] = [];
    
    // Add session context
    lines.push(`# Conversation with ${sessionName}`);
    lines.push('');
    
    // Add session metadata if available
    if (session.metadata?.summary?.text) {
        lines.push('## Session Summary');
        lines.push(session.metadata.summary.text);
        lines.push('');
    }
    
    lines.push('## Conversation History');
    lines.push('');
    
    // Process messages in chronological order (reverse the array since it's sorted newest first)
    const chronologicalMessages = [...messages].reverse();
    
    for (const message of chronologicalMessages) {
        switch (message.kind) {
            case 'user-text':
                lines.push(`**User**: ${message.text}`);
                lines.push('');
                break;
                
            case 'agent-text':
                lines.push(`**Assistant**: ${message.text}`);
                lines.push('');
                break;
                
            case 'tool-call':
                lines.push('**Assistant** executed tools:');
                for (const tool of message.tools) {
                    lines.push(`- ${tool.name}${tool.state === 'error' ? ' (failed)' : ''}`);
                }
                lines.push('');
                break;
                
            case 'tool-call-group':
                // Skip these as they're just grouping metadata
                break;
        }
    }
    
    // Add current session state
    if (session.thinking) {
        lines.push('---');
        lines.push('*Assistant is currently thinking...*');
    }
    
    return lines.join('\n').trim();
}