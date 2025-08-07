import { Session } from '@/sync/storageTypes';
import { Message } from '@/sync/typesMessage';

/**
 * Convert slice of a conversation to a prompt for the realtime session.
 */
export function messagesToPrompt(messagesFromMostRecentToOldest: Message[], options: {
    maxCharacters?: number
    maxMessages?: number
    excludeToolCalls?: boolean
}): string {
    const lines: string[] = [];

    let messages = [...messagesFromMostRecentToOldest];

    if (options.maxMessages && options.maxMessages < messages.length) {
        console.log('🔍 truncating messages to', options.maxMessages);
        console.log(`Oldest message being dropped: ${JSON.stringify(messages[messages.length - 1], null, 2)}`);

        messages = messages.slice(0, options.maxMessages);
    }

    const mainContentLines = [];
    for (const message of messages) {
        switch (message.kind) {
            case 'user-text':
                mainContentLines.push(`**User**: ${message.text}`);
                mainContentLines.push('');
                break;
                
            case 'agent-text':
                mainContentLines.push(`**Claude Code**: ${message.text}`);
                mainContentLines.push('');
                break;
                
            case 'tool-call':
                if (options.excludeToolCalls) {
                    break;
                }

                if (message.tool) {
                    mainContentLines.push(`**Claude Code** executed tool: ${message.tool.name}${message.tool.state === 'error' ? ' (failed)' : ''}`);
                    
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

export function sessionToRealtimePrompt(session: Session, messagesFromMostRecentToOldest: Message[], options: {
    maxCharacters?: number
    maxMessages?: number
    excludeToolCalls?: boolean
}): string {
    const sessionName = session.metadata?.summary?.text;
    const sessionPath = session.metadata?.path;
    const lines: string[] = [];
    
    // Add session context
    lines.push(`# Project path: ${sessionPath}`);
    lines.push(`# Session summary:\n${sessionName}`);
    
    // Add session metadata if available
    if (session.metadata?.summary?.text) {
        lines.push('## Session Summary');
        lines.push(session.metadata.summary.text);
        lines.push('');
    }
    
    lines.push('## Our interaction history so far');
    lines.push('');
    
    lines.push(messagesToPrompt(messagesFromMostRecentToOldest, options));
    
    // Add current session state
    if (session.thinking) {
        lines.push('---');
        lines.push('*Assistant is currently thinking...*');
    }
    
    return lines.join('\n').trim();
}