/**
 * Export session history to markdown or JSON format
 */

import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { getProjectPath } from './path';
import { RawJSONLinesSchema, RawJSONLines } from '../types';
import { logger } from '@/ui/logger';

export interface ExportOptions {
    format: 'markdown' | 'json';
    destination: 'mobile' | 'cli';
    filename?: string;
}

export interface ExportResult {
    success: boolean;
    content?: string;      // For mobile - the exported content
    filePath?: string;     // For CLI - the saved file path
    error?: string;
}

/**
 * Export session history to specified format
 */
export async function exportSession(
    workingDirectory: string,
    sessionId: string,
    options: ExportOptions
): Promise<ExportResult> {
    if (!sessionId) {
        return { success: false, error: 'No session ID available' };
    }

    const projectDir = getProjectPath(workingDirectory);
    const sessionFile = join(projectDir, `${sessionId}.jsonl`);

    logger.debug(`[export] Exporting session ${sessionId} from ${sessionFile}`);

    try {
        const fileContent = await readFile(sessionFile, 'utf-8');
        const lines = fileContent.split('\n').filter(l => l.trim());

        const messages: RawJSONLines[] = [];
        for (const line of lines) {
            try {
                const parsed = JSON.parse(line);
                const validated = RawJSONLinesSchema.safeParse(parsed);
                if (validated.success) {
                    messages.push(validated.data);
                }
            } catch {
                // Skip invalid lines
            }
        }

        logger.debug(`[export] Found ${messages.length} messages in session`);

        if (messages.length === 0) {
            return { success: false, error: 'No messages found in session' };
        }

        if (options.format === 'json') {
            const content = JSON.stringify(messages, null, 2);
            return handleExportDestination(content, options, workingDirectory, sessionId, 'json');
        }

        // Markdown format
        const content = formatMessagesToMarkdown(messages, sessionId);
        return handleExportDestination(content, options, workingDirectory, sessionId, 'md');

    } catch (error: any) {
        logger.debug(`[export] Error exporting session: ${error.message}`);
        if (error.code === 'ENOENT') {
            return { success: false, error: 'Session file not found' };
        }
        return { success: false, error: error.message };
    }
}

/**
 * Format messages to readable markdown
 */
function formatMessagesToMarkdown(messages: RawJSONLines[], sessionId: string): string {
    let md = `# Session Export\n\n`;
    md += `**Session ID:** \`${sessionId}\`\n`;
    md += `**Exported at:** ${new Date().toISOString()}\n`;
    md += `**Messages:** ${messages.length}\n\n`;
    md += `---\n\n`;

    for (const msg of messages) {
        if (msg.type === 'user') {
            const content = extractUserContent(msg);
            md += `## 👤 User\n\n${content}\n\n`;
        } else if (msg.type === 'assistant') {
            const content = extractAssistantContent(msg);
            if (content) {
                md += `## 🤖 Assistant\n\n${content}\n\n`;
            }
        } else if (msg.type === 'summary') {
            md += `## 📝 Summary\n\n${msg.summary}\n\n`;
        }
    }

    return md;
}

/**
 * Extract text content from user message
 */
function extractUserContent(msg: RawJSONLines): string {
    if (msg.type !== 'user') return '';

    const content = msg.message.content;
    if (typeof content === 'string') {
        return content;
    }

    // Handle array content (multimodal messages)
    if (Array.isArray(content)) {
        return content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n\n');
    }

    return JSON.stringify(content, null, 2);
}

/**
 * Extract text content from assistant message
 */
function extractAssistantContent(msg: RawJSONLines): string {
    if (msg.type !== 'assistant') return '';

    const message = msg.message as any;
    if (!message?.content) return '';

    // Handle array content (typical Claude response format)
    if (Array.isArray(message.content)) {
        const textParts = message.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text);

        if (textParts.length > 0) {
            return textParts.join('\n\n');
        }

        // If no text parts, check for tool use
        const toolParts = message.content
            .filter((c: any) => c.type === 'tool_use')
            .map((c: any) => `*Tool: ${c.name}*`);

        if (toolParts.length > 0) {
            return toolParts.join('\n');
        }

        return '';
    }

    if (typeof message.content === 'string') {
        return message.content;
    }

    return '';
}

/**
 * Handle export destination (mobile vs CLI)
 */
async function handleExportDestination(
    content: string,
    options: ExportOptions,
    workingDirectory: string,
    sessionId: string,
    extension: string
): Promise<ExportResult> {
    if (options.destination === 'cli') {
        // Save to CLI working directory
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = options.filename || `session-export-${timestamp}.${extension}`;
        const filePath = join(workingDirectory, filename);

        await writeFile(filePath, content, 'utf-8');
        logger.debug(`[export] Saved to ${filePath}`);

        return { success: true, filePath, content };
    }

    // Return content for mobile display
    return { success: true, content };
}
