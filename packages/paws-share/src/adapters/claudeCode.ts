import type { PublicSessionBlock, PublicSessionSnapshot } from '@slopus/happy-wire';
import {
    publicTitle,
    readStableJsonLines,
    recordValue,
    resolveStructuredAttachment,
    stringValue,
    timestamp,
} from './shared';
import type { ConvertedSnapshot, ResolvedAttachment, TranscriptAdapter, TranscriptCandidate } from './types';

type ToolBlock = Extract<PublicSessionBlock, { type: 'tool' }>;

export const claudeCodeAdapter: TranscriptAdapter = {
    provider: 'claude-code',
    async convert(candidate: TranscriptCandidate): Promise<ConvertedSnapshot> {
        const lines = await readStableJsonLines(candidate);
        const messages: PublicSessionSnapshot['messages'] = [];
        const attachments = new Map<string, ResolvedAttachment>();
        const unresolvedAttachments: string[] = [];
        const tools = new Map<string, ToolBlock>();
        const seen = new Set<string>();
        let recordedCwd = candidate.cwd;
        let firstUserText: string | undefined;
        let sequence = 0;

        for (const line of lines) {
            const uuid = stringValue(line.uuid);
            if (uuid && seen.has(uuid)) continue;
            if (uuid) seen.add(uuid);
            recordedCwd = stringValue(line.cwd) ?? recordedCwd;
            const message = recordValue(line.message);
            if (!message || (line.type !== 'user' && line.type !== 'assistant')) continue;
            const createdAt = timestamp(line.timestamp, Date.now() + sequence++);
            const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }]
                : Array.isArray(message.content) ? message.content : [];
            const blocks: PublicSessionBlock[] = [];

            for (const rawBlock of content) {
                const block = recordValue(rawBlock);
                if (!block) continue;
                const text = stringValue(block.text);
                if (block.type === 'text' && text) {
                    blocks.push({ type: 'text', markdown: text });
                    if (line.type === 'user' && !firstUserText) firstUserText = text;
                    continue;
                }
                const thinking = stringValue(block.thinking);
                if (block.type === 'thinking' && thinking) {
                    blocks.push({ type: 'thinking', markdown: thinking });
                    continue;
                }
                if (block.type === 'tool_use') {
                    const toolId = stringValue(block.id);
                    const name = stringValue(block.name);
                    if (!toolId || !name) continue;
                    const tool: ToolBlock = {
                        type: 'tool',
                        name,
                        status: 'running',
                        body: block.input === undefined ? undefined : JSON.stringify(block.input),
                    };
                    tools.set(toolId, tool);
                    blocks.push(tool);
                    continue;
                }
                if (block.type === 'tool_result') {
                    const toolId = stringValue(block.tool_use_id);
                    const tool = toolId ? tools.get(toolId) : undefined;
                    if (tool) {
                        tool.status = block.is_error === true ? 'failed' : 'completed';
                        tool.body = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                    }
                    continue;
                }
                if (block.type === 'image') {
                    const source = recordValue(block.source);
                    const reference = stringValue(source?.path);
                    if (!reference) continue;
                    try {
                        const attachment = await resolveStructuredAttachment(candidate, reference, recordedCwd);
                        attachments.set(attachment.path, attachment);
                        blocks.push({
                            type: 'attachment',
                            attachmentId: attachment.attachmentId,
                            kind: attachment.kind,
                            name: attachment.name,
                            mimeType: attachment.mimeType,
                            size: attachment.size,
                            source: 'user',
                        });
                    } catch {
                        unresolvedAttachments.push(reference);
                    }
                }
            }
            if (blocks.length > 0) messages.push({
                id: uuid ?? `claude-message-${sequence}`,
                role: line.type,
                createdAt,
                blocks,
            });
        }

        return {
            snapshot: {
                version: 1,
                title: publicTitle(firstUserText),
                sharedAt: Date.now(),
                source: { provider: 'claude-code' },
                presentation: { groupToolCalls: true },
                messages,
            },
            attachments: Array.from(attachments.values()),
            unresolvedAttachments,
        };
    },
};
