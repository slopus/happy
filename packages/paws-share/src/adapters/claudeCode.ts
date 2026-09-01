import type { PublicSessionBlock, PublicSessionSnapshot } from '@slopus/happy-wire';
import {
    decodeBase64Bytes,
    publicTitle,
    readStableJsonLines,
    recordValue,
    resolveEmbeddedImageAttachment,
    resolveStructuredAttachment,
    stringValue,
    timestamp,
} from './shared';
import type { ConvertedSnapshot, ResolvedAttachment, TranscriptAdapter, TranscriptCandidate } from './types';
import type { JsonLine } from './shared';

type ToolBlock = Extract<PublicSessionBlock, { type: 'tool' }>;

function latestClaudeAncestry(lines: JsonLine[]): JsonLine[] {
    const byUuid = new Map<string, JsonLine>();
    let leafUuid: string | undefined;
    for (const line of lines) {
        if (line.isSidechain === true || (line.type !== 'user' && line.type !== 'assistant') || !recordValue(line.message)) continue;
        const uuid = stringValue(line.uuid);
        if (!uuid) continue;
        byUuid.set(uuid, line);
        leafUuid = uuid;
    }
    if (!leafUuid) {
        return lines.filter((line) => line.isSidechain !== true && (line.type === 'user' || line.type === 'assistant'));
    }
    const newestToOldest: JsonLine[] = [];
    const visited = new Set<string>();
    let current: string | undefined = leafUuid;
    while (current && !visited.has(current)) {
        visited.add(current);
        const line = byUuid.get(current);
        if (!line) throw new Error('Claude Code session ancestry is incomplete; retry from a complete session transcript');
        newestToOldest.push(line);
        current = stringValue(line.parentUuid);
    }
    return newestToOldest.reverse();
}

async function appendClaudeImage(options: {
    rawBlock: Record<string, unknown>;
    candidate: TranscriptCandidate;
    recordedCwd?: string;
    referenceKey: string;
    blocks: PublicSessionBlock[];
    attachments: Map<string, ResolvedAttachment>;
    unresolvedAttachments: string[];
}): Promise<void> {
    const source = recordValue(options.rawBlock.source);
    try {
        const pathReference = stringValue(source?.path);
        const attachment = pathReference
            ? await resolveStructuredAttachment(options.candidate, pathReference, options.recordedCwd)
            : resolveEmbeddedImageAttachment(
                options.candidate,
                decodeBase64Bytes(stringValue(source?.data) ?? ''),
                stringValue(source?.media_type) ?? '',
                options.referenceKey,
            );
        options.attachments.set(attachment.attachmentId, attachment);
        options.blocks.push({
            type: 'attachment',
            attachmentId: attachment.attachmentId,
            kind: attachment.kind,
            name: attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.size,
            source: 'user',
        });
    } catch {
        options.unresolvedAttachments.push(options.referenceKey);
    }
}

export const claudeCodeAdapter: TranscriptAdapter = {
    provider: 'claude-code',
    async convert(candidate: TranscriptCandidate): Promise<ConvertedSnapshot> {
        const lines = latestClaudeAncestry(await readStableJsonLines(candidate));
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

            for (const [blockIndex, rawBlock] of content.entries()) {
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
                    if (tool) tool.status = block.is_error === true ? 'failed' : 'completed';
                    if (Array.isArray(block.content)) {
                        const body: string[] = [];
                        for (const [resultIndex, rawResult] of block.content.entries()) {
                            const result = recordValue(rawResult);
                            if (result?.type === 'image') {
                                await appendClaudeImage({
                                    rawBlock: result,
                                    candidate,
                                    recordedCwd,
                                    referenceKey: `${uuid ?? sequence}:tool-result:${blockIndex}:${resultIndex}`,
                                    blocks,
                                    attachments,
                                    unresolvedAttachments,
                                });
                            } else if (result?.type === 'text' && stringValue(result.text)) {
                                body.push(stringValue(result.text)!);
                            } else {
                                body.push(JSON.stringify(rawResult));
                            }
                        }
                        if (tool) tool.body = body.length > 0 ? body.join('\n') : undefined;
                    } else if (tool) {
                        tool.body = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                    }
                    continue;
                }
                if (block.type === 'image') {
                    await appendClaudeImage({
                        rawBlock: block,
                        candidate,
                        recordedCwd,
                        referenceKey: `${uuid ?? sequence}:image:${blockIndex}`,
                        blocks,
                        attachments,
                        unresolvedAttachments,
                    });
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
                messages: [...messages].reverse(),
            },
            attachments: Array.from(attachments.values()),
            unresolvedAttachments,
        };
    },
};
