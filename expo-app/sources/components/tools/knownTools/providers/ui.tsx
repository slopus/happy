import * as z from 'zod';
import { t } from '@/text';
import { ICON_EDIT } from '../icons';
import type { KnownToolDefinition } from '../_types';

export const providerUiTools = {
    'change_title': {
        title: t('tools.names.changeTitle'),
        icon: ICON_EDIT,
        minimal: true,
        noStatus: true,
        input: z.object({
            title: z.string().optional().describe('New session title')
        }).partial().loose(),
        result: z.object({}).partial().loose()
    },
} satisfies Record<string, KnownToolDefinition>;

