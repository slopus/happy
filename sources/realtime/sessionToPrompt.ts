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

                if (message.tool) {
                    mainContentLines.push(`**Assistant** executed tool: ${message.tool.name}${message.tool.state === 'error' ? ' (failed)' : ''}`);
                    
                    // Include children if any
                    if (message.children && message.children.length > 0) {
                        mainContentLines.push('  with sub-operations:');
                        for (const child of message.children) {
                            if (child.kind === 'tool-call' && child.tool) {
                                mainContentLines.push(`  - ${child.tool.name}${child.tool.state === 'error' ? ' (failed)' : ''}`);
                            }
                        }
                    }
                }
                mainContentLines.push('');
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