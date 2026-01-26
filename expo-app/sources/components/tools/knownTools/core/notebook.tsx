import type { Metadata } from '@/sync/storageTypes';
import type { ToolCall } from '@/sync/typesMessage';
import { resolvePath } from '@/utils/pathUtils';
import * as z from 'zod';
import { t } from '@/text';
import { ICON_READ, ICON_EDIT } from '../icons';
import type { KnownToolDefinition } from '../_types';

export const coreNotebookTools = {
    'NotebookRead': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.notebook_path === 'string') {
                const path = resolvePath(opts.tool.input.notebook_path, opts.metadata);
                return path;
            }
            return t('tools.names.readNotebook');
        },
        icon: ICON_READ,
        minimal: true,
        input: z.object({
            notebook_path: z.string().describe('The absolute path to the Jupyter notebook file'),
            cell_id: z.string().optional().describe('The ID of a specific cell to read')
        }).partial().loose()
    },
    'NotebookEdit': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.notebook_path === 'string') {
                const path = resolvePath(opts.tool.input.notebook_path, opts.metadata);
                return path;
            }
            return t('tools.names.editNotebook');
        },
        icon: ICON_EDIT,
        isMutable: true,
        input: z.object({
            notebook_path: z.string().describe('The absolute path to the notebook file'),
            new_source: z.string().describe('The new source for the cell'),
            cell_id: z.string().optional().describe('The ID of the cell to edit'),
            cell_type: z.enum(['code', 'markdown']).optional().describe('The type of the cell'),
            edit_mode: z.enum(['replace', 'insert', 'delete']).optional().describe('The type of edit to make')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.notebook_path === 'string') {
                const path = resolvePath(opts.tool.input.notebook_path, opts.metadata);
                const mode = opts.tool.input.edit_mode || 'replace';
                return t('tools.desc.editNotebookMode', { path, mode });
            }
            return t('tools.names.editNotebook');
        }
    },
} satisfies Record<string, KnownToolDefinition>;

