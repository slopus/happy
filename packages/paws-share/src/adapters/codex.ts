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

export const codexAdapter: TranscriptAdapter = {
    provider: 'codex',
    async convert(candidate: TranscriptCandidate): Promise<ConvertedSnapshot> {
        const lines = await readStableJsonLines(candidate);
        const attachments = new Map<string, ResolvedAttachment>();
        const unresolvedAttachments: string[] = [];
        const messages: PublicSessionSnapshot['messages'] = [];
        const tools = new Map<string, ToolBlock>();
        const seen = new Set<string>();
        let recordedCwd = candidate.cwd;
        let firstUserText: string | undefined;
        let sequence = 0;

        for (const line of lines) {
            const payload = recordValue(line.payload);
            if (line.type === 'session_meta') {
                recordedCwd = stringValue(payload?.cwd) ?? recordedCwd;
                continue;
            }
            if (!payload) continue;
            const stableId = stringValue(payload.id);
            if (stableId && seen.has(stableId)) continue;
            if (stableId) seen.add(stableId);
            const createdAt = timestamp(line.timestamp, Date.now() + sequence++);

            if (line.type === 'event_msg' && payload.type === 'agent_reasoning') {
                const markdown = stringValue(payload.text);
                if (markdown) messages.push({
                    id: stableId ?? `codex-thinking-${sequence}`,
                    role: 'assistant',
                    createdAt,
                    blocks: [{ type: 'thinking', markdown }],
                });
                continue;
            }
            if (line.type !== 'response_item') continue;

            if (payload.type === 'function_call') {
                const callId = stringValue(payload.call_id);
                const name = stringValue(payload.name);
                if (!callId || !name) continue;
                const tool: ToolBlock = {
                    type: 'tool',
                    name,
                    status: 'running',
                    body: stringValue(payload.arguments),
                };
                tools.set(callId, tool);
                messages.push({
                    id: stableId ?? `codex-tool-${sequence}`,
                    role: 'assistant',
                    createdAt,
                    blocks: [tool],
                });
                continue;
            }
            if (payload.type === 'function_call_output') {
                const callId = stringValue(payload.call_id);
                const tool = callId ? tools.get(callId) : undefined;
                if (tool) {
                    tool.status = 'completed';
                    tool.body = stringValue(payload.output) ?? tool.body;
                }
                continue;
            }
            if (payload.type !== 'message' || (payload.role !== 'user' && payload.role !== 'assistant')) continue;
            const content = Array.isArray(payload.content) ? payload.content : [];
            const blocks: PublicSessionBlock[] = [];
            for (const rawBlock of content) {
                const block = recordValue(rawBlock);
                if (!block) continue;
                const text = stringValue(block.text);
                if ((block.type === 'input_text' || block.type === 'output_text') && text) {
                    blocks.push({ type: 'text', markdown: text });
                    if (payload.role === 'user' && !firstUserText) firstUserText = text;
                    continue;
                }
                const reference = stringValue(block.image_url) ?? stringValue(block.path);
                if (block.type === 'input_image' && reference) {
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
                id: stableId ?? `codex-message-${sequence}`,
                role: payload.role,
                createdAt,
                blocks,
            });
        }

        return {
            snapshot: {
                version: 1,
                title: publicTitle(firstUserText),
                sharedAt: Date.now(),
                source: { provider: 'codex' },
                presentation: { groupToolCalls: true },
                messages: [...messages].reverse(),
            },
            attachments: Array.from(attachments.values()),
            unresolvedAttachments,
        };
    },
};
