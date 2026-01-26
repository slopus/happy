import type { Metadata } from '@/sync/storageTypes';
import type { ToolCall } from '@/sync/typesMessage';
import { resolvePath } from '@/utils/pathUtils';
import * as z from 'zod';
import { t } from '@/text';
import { ICON_READ, ICON_EDIT } from '../icons';
import type { KnownToolDefinition } from '../_types';

export const coreFileTools = {
    'Read': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                return path;
            }
            // Gemini uses 'locations' array with 'path' field
            if (Array.isArray(opts.tool.input.locations)) {
                const maybePath = opts.tool.input.locations[0]?.path;
                if (typeof maybePath === 'string' && maybePath.length > 0) {
                    const path = resolvePath(maybePath, opts.metadata);
                    return path;
                }
            }
            return t('tools.names.readFile');
        },
        minimal: true,
        icon: ICON_READ,
        input: z.object({
            file_path: z.string().describe('The absolute path to the file to read'),
            limit: z.number().optional().describe('The number of lines to read'),
            offset: z.number().optional().describe('The line number to start reading from'),
            // Gemini format
            items: z.array(z.any()).optional(),
            locations: z.array(z.object({ path: z.string() }).loose()).optional()
        }).partial().loose(),
        result: z.object({
            file: z.object({
                filePath: z.string().describe('The absolute path to the file to read'),
                content: z.string().describe('The content of the file'),
                numLines: z.number().describe('The number of lines in the file'),
                startLine: z.number().describe('The line number to start reading from'),
                totalLines: z.number().describe('The total number of lines in the file')
            }).loose().optional()
        }).partial().loose()
    },
    // Gemini uses lowercase 'read'
    'read': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Gemini uses 'locations' array with 'path' field
            if (Array.isArray(opts.tool.input.locations)) {
                const maybePath = opts.tool.input.locations[0]?.path;
                if (typeof maybePath === 'string' && maybePath.length > 0) {
                    const path = resolvePath(maybePath, opts.metadata);
                    return path;
                }
            }
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                return path;
            }
            return t('tools.names.readFile');
        },
        minimal: true,
        icon: ICON_READ,
        input: z.object({
            items: z.array(z.any()).optional(),
            locations: z.array(z.object({ path: z.string() }).loose()).optional(),
            file_path: z.string().optional()
        }).partial().loose()
    },
    'Edit': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                return path;
            }
            return t('tools.names.editFile');
        },
        icon: ICON_EDIT,
        isMutable: true,
        input: z.object({
            file_path: z.string().describe('The absolute path to the file to modify'),
            old_string: z.string().describe('The text to replace'),
            new_string: z.string().describe('The text to replace it with'),
            replace_all: z.boolean().optional().default(false).describe('Replace all occurrences')
        }).partial().loose()
    },
    'MultiEdit': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                const editCount = Array.isArray(opts.tool.input.edits) ? opts.tool.input.edits.length : 0;
                if (editCount > 1) {
                    return t('tools.desc.multiEditEdits', { path, count: editCount });
                }
                return path;
            }
            return t('tools.names.editFile');
        },
        icon: ICON_EDIT,
        isMutable: true,
        input: z.object({
            file_path: z.string().describe('The absolute path to the file to modify'),
            edits: z.array(z.object({
                old_string: z.string().describe('The text to replace'),
                new_string: z.string().describe('The text to replace it with'),
                replace_all: z.boolean().optional().default(false).describe('Replace all occurrences')
            })).describe('Array of edit operations')
        }).partial().loose(),
        extractStatus: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                const editCount = Array.isArray(opts.tool.input.edits) ? opts.tool.input.edits.length : 0;
                if (editCount > 0) {
                    return t('tools.desc.multiEditEdits', { path, count: editCount });
                }
                return path;
            }
            return null;
        }
    },
    'Write': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                return path;
            }
            return t('tools.names.writeFile');
        },
        icon: ICON_EDIT,
        isMutable: true,
        input: z.object({
            file_path: z.string().describe('The absolute path to the file to write'),
            content: z.string().describe('The content to write to the file')
        }).partial().loose()
    },
} satisfies Record<string, KnownToolDefinition>;

