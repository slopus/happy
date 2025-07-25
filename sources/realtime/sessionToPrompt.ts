import { Session } from '@/sync/storageTypes';
import { Message } from '@/sync/typesMessage';
import { getSessionName } from '@/utils/sessionUtils';

/**
 * Convert slice of a conversation to a prompt for the realtime session.
 */
export function messagesToPrompt(messages: Message[], options: {
    maxCharacters?: number
    maxMessages?: number
    excludeToolCalls?: boolean
}): string {
    const lines: string[] = [];
    
    let messagesToInclude = messages;
    if (options.maxMessages && options.maxMessages < messages.length) {
        messagesToInclude = messages.slice(0, options.maxMessages);
    }

    // Process messages in chronological order (reverse the array since it's sorted newest first)
    const chronologicalMessages = [...messagesToInclude].reverse();
    
    const mainContentLines = [];
    for (const message of chronologicalMessages) {
        switch (message.kind) {
            case 'user-text':
                mainContentLines.push(`**User**: ${message.text}`);
                mainContentLines.push('');
                break;
                
            case 'agent-text':
                mainContentLines.push(`**Assistant**: ${message.text}`);
                mainContentLines.push('');
                break;
                
            case 'tool-call':
                if (options.excludeToolCalls) {
                    break;
                }

                mainContentLines.push('**Assistant** executed tools:');
                for (const tool of message.tools) {
                    mainContentLines.push(`- ${tool.name}${tool.state === 'error' ? ' (failed)' : ''}`);
                }
                mainContentLines.push('');
                break;
                
            case 'tool-call-group':
                // Skip these as they're just grouping metadata
                break;
        }
    }

    const mainContent = mainContentLines.join('\n').trim();
    if (options.maxCharacters && mainContent.length > options.maxCharacters) {
        lines.push('... (truncated above to save space) ...');
        lines.push(mainContent.slice(mainContent.length - options.maxCharacters));
    } else {
        lines.push(mainContent);
    }    

    return lines.join('\n').trim();
}

export function sessionToRealtimePrompt(session: Session, messages: Message[], options: {
    maxCharacters?: number
    maxMessages?: number
    excludeToolCalls?: boolean
}): string {
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
    
    lines.push(messagesToPrompt(messages, options));
    
    // Add current session state
    if (session.thinking) {
        lines.push('---');
        lines.push('*Assistant is currently thinking...*');
    }
    
    return lines.join('\n').trim();
}