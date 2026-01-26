import type { Metadata } from '@/sync/storageTypes';
import type { ToolCall } from '@/sync/typesMessage';
import * as z from 'zod';
import { t } from '@/text';
import { ICON_WEB } from '../icons';
import type { KnownToolDefinition } from '../_types';

export const coreWebTools = {
    'WebFetch': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.url === 'string') {
                try {
                    const url = new URL(opts.tool.input.url);
                    return url.hostname;
                } catch {
                    return t('tools.names.fetchUrl');
                }
            }
            return t('tools.names.fetchUrl');
        },
        icon: ICON_WEB,
        minimal: true,
        input: z.object({
            url: z.string().url().describe('The URL to fetch content from'),
            prompt: z.string().describe('The prompt to run on the fetched content')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.url === 'string') {
                try {
                    const url = new URL(opts.tool.input.url);
                    return t('tools.desc.fetchUrlHost', { host: url.hostname });
                } catch {
                    return t('tools.names.fetchUrl');
                }
            }
            return 'Fetch URL';
        }
    },
    'WebSearch': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.query === 'string') {
                return opts.tool.input.query;
            }
            return t('tools.names.webSearch');
        },
        icon: ICON_WEB,
        minimal: true,
        input: z.object({
            query: z.string().min(2).describe('The search query to use'),
            allowed_domains: z.array(z.string()).optional().describe('Only include results from these domains'),
            blocked_domains: z.array(z.string()).optional().describe('Never include results from these domains')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.query === 'string') {
                const query = opts.tool.input.query.length > 30
                    ? opts.tool.input.query.substring(0, 30) + '...'
                    : opts.tool.input.query;
                return t('tools.desc.webSearchQuery', { query });
            }
            return t('tools.names.webSearch');
        }
    },
} satisfies Record<string, KnownToolDefinition>;

