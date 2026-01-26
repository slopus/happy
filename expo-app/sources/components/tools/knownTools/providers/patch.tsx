import type { Metadata } from '@/sync/storageTypes';
import type { ToolCall } from '@/sync/typesMessage';
import { resolvePath } from '@/utils/pathUtils';
import * as z from 'zod';
import { t } from '@/text';
import { ICON_EDIT } from '../icons';
import type { KnownToolDefinition } from '../_types';

export const providerPatchTools = {
    'edit': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Gemini sends data in nested structure, try multiple locations
            let filePath: string | undefined;

            // 1. Check toolCall.content[0].path
            if (typeof opts.tool.input?.toolCall?.content?.[0]?.path === 'string') {
                filePath = opts.tool.input.toolCall.content[0].path;
            }
            // 2. Check toolCall.title (has nice "Writing to ..." format)
            else if (typeof opts.tool.input?.toolCall?.title === 'string') {
                return opts.tool.input.toolCall.title;
            }
            // 3. Check input[0].path (array format)
            else if (Array.isArray(opts.tool.input?.input) && typeof opts.tool.input.input[0]?.path === 'string') {
                filePath = opts.tool.input.input[0].path;
            }
            // 4. Check direct path field
            else if (typeof opts.tool.input?.path === 'string') {
                filePath = opts.tool.input.path;
            }

            if (typeof filePath === 'string' && filePath.length > 0) {
                return resolvePath(filePath, opts.metadata);
            }
            return t('tools.names.editFile');
        },
        icon: ICON_EDIT,
        isMutable: true,
        input: z.object({
            path: z.string().describe('The file path to edit'),
            oldText: z.string().describe('The text to replace'),
            newText: z.string().describe('The new text'),
            type: z.string().optional().describe('Type of edit (diff)')
        }).partial().loose()
    },
    'CodexPatch': {
        title: t('tools.names.applyChanges'),
        icon: ICON_EDIT,
        minimal: true,
        hideDefaultError: true,
        input: z.object({
            auto_approved: z.boolean().optional().describe('Whether changes were auto-approved'),
            changes: z.record(z.string(), z.object({
                add: z.object({
                    content: z.string()
                }).optional(),
                modify: z.object({
                    old_content: z.string(),
                    new_content: z.string()
                }).optional(),
                delete: z.object({
                    content: z.string()
                }).optional()
            }).loose()).describe('File changes to apply')
        }).partial().loose(),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Show the first file being modified
            if (opts.tool.input?.changes && typeof opts.tool.input.changes === 'object') {
                const files = Object.keys(opts.tool.input.changes);
                if (files.length > 0) {
                    const path = resolvePath(files[0], opts.metadata);
                    const fileName = path.split('/').pop() || path;
                    if (files.length > 1) {
                        return t('tools.desc.modifyingMultipleFiles', {
                            file: fileName,
                            count: files.length - 1
                        });
                    }
                    return fileName;
                }
            }
            return null;
        },
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Show the number of files being modified
            if (opts.tool.input?.changes && typeof opts.tool.input.changes === 'object') {
                const files = Object.keys(opts.tool.input.changes);
                const fileCount = files.length;
                if (fileCount === 1) {
                    const path = resolvePath(files[0], opts.metadata);
                    const fileName = path.split('/').pop() || path;
                    return t('tools.desc.modifyingFile', { file: fileName });
                } else if (fileCount > 1) {
                    return t('tools.desc.modifyingFiles', { count: fileCount });
                }
            }
            return t('tools.names.applyChanges');
        }
    },
    'GeminiPatch': {
        title: t('tools.names.applyChanges'),
        icon: ICON_EDIT,
        minimal: true,
        hideDefaultError: true,
        isMutable: true,
        input: z.object({
            auto_approved: z.boolean().optional().describe('Whether changes were auto-approved'),
            changes: z.record(z.string(), z.object({
                add: z.object({
                    content: z.string()
                }).optional(),
                modify: z.object({
                    old_content: z.string(),
                    new_content: z.string()
                }).optional(),
                delete: z.object({
                    content: z.string()
                }).optional()
            }).loose()).describe('File changes to apply')
        }).partial().loose(),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Show the first file being modified
            if (opts.tool.input?.changes && typeof opts.tool.input.changes === 'object') {
                const files = Object.keys(opts.tool.input.changes);
                if (files.length > 0) {
                    const path = resolvePath(files[0], opts.metadata);
                    const fileName = path.split('/').pop() || path;
                    if (files.length > 1) {
                        return t('tools.desc.modifyingMultipleFiles', {
                            file: fileName,
                            count: files.length - 1
                        });
                    }
                    return fileName;
                }
            }
            return null;
        },
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Show the number of files being modified
            if (opts.tool.input?.changes && typeof opts.tool.input.changes === 'object') {
                const files = Object.keys(opts.tool.input.changes);
                const fileCount = files.length;
                if (fileCount === 1) {
                    const path = resolvePath(files[0], opts.metadata);
                    const fileName = path.split('/').pop() || path;
                    return t('tools.desc.modifyingFile', { file: fileName });
                } else if (fileCount > 1) {
                    return t('tools.desc.modifyingFiles', { count: fileCount });
                }
            }
            return t('tools.names.applyChanges');
        }
    },
} satisfies Record<string, KnownToolDefinition>;

