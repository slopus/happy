import type { Metadata } from '@/sync/storageTypes';
import type { ToolCall } from '@/sync/typesMessage';
import { resolvePath } from '@/utils/pathUtils';
import * as z from 'zod';
import { t } from '@/text';
import { ICON_SEARCH, ICON_READ } from '../icons';
import type { KnownToolDefinition } from '../_types';

export const coreSearchTools = {
    'Glob': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.pattern === 'string') {
                return opts.tool.input.pattern;
            }
            return t('tools.names.searchFiles');
        },
        icon: ICON_SEARCH,
        minimal: true,
        input: z.object({
            pattern: z.string().describe('The glob pattern to match files against'),
            path: z.string().optional().describe('The directory to search in')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.pattern === 'string') {
                return t('tools.desc.searchPattern', { pattern: opts.tool.input.pattern });
            }
            return t('tools.names.search');
        }
    },
    'Grep': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.pattern === 'string') {
                return `grep(pattern: ${opts.tool.input.pattern})`;
            }
            return 'Search Content';
        },
        icon: ICON_READ,
        minimal: true,
        input: z.object({
            pattern: z.string().describe('The regular expression pattern to search for'),
            path: z.string().optional().describe('File or directory to search in'),
            output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
            '-n': z.boolean().optional().describe('Show line numbers'),
            '-i': z.boolean().optional().describe('Case insensitive search'),
            '-A': z.number().optional().describe('Lines to show after match'),
            '-B': z.number().optional().describe('Lines to show before match'),
            '-C': z.number().optional().describe('Lines to show before and after match'),
            glob: z.string().optional().describe('Glob pattern to filter files'),
            type: z.string().optional().describe('File type to search'),
            head_limit: z.number().optional().describe('Limit output to first N lines/entries'),
            multiline: z.boolean().optional().describe('Enable multiline mode')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.pattern === 'string') {
                const pattern = opts.tool.input.pattern.length > 20
                    ? opts.tool.input.pattern.substring(0, 20) + '...'
                    : opts.tool.input.pattern;
                return `Search(pattern: ${pattern})`;
            }
            return 'Search';
        }
    },
    'LS': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.path === 'string') {
                return resolvePath(opts.tool.input.path, opts.metadata);
            }
            return t('tools.names.listFiles');
        },
        icon: ICON_SEARCH,
        minimal: true,
        input: z.object({
            path: z.string().describe('The absolute path to the directory to list'),
            ignore: z.array(z.string()).optional().describe('List of glob patterns to ignore')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.path === 'string') {
                const path = resolvePath(opts.tool.input.path, opts.metadata);
                const basename = path.split('/').pop() || path;
                return t('tools.desc.searchPath', { basename });
            }
            return t('tools.names.search');
        }
    },
    'CodeSearch': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const query = typeof opts.tool.input?.query === 'string'
                ? opts.tool.input.query
                : typeof opts.tool.input?.pattern === 'string'
                    ? opts.tool.input.pattern
                    : null;
            if (query && query.trim()) return query.trim();
            return 'Code Search';
        },
        icon: ICON_SEARCH,
        minimal: true,
        input: z.object({
            query: z.string().optional().describe('The search query'),
            pattern: z.string().optional().describe('The search pattern'),
            path: z.string().optional().describe('Optional path scope'),
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const query = typeof opts.tool.input?.query === 'string'
                ? opts.tool.input.query
                : typeof opts.tool.input?.pattern === 'string'
                    ? opts.tool.input.pattern
                    : null;
            if (query && query.trim()) {
                const truncated = query.length > 30 ? query.substring(0, 30) + '...' : query;
                return truncated;
            }
            return 'Search in code';
        }
    },
} satisfies Record<string, KnownToolDefinition>;

