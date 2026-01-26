import * as z from 'zod';
import { t } from '@/text';
import { ICON_SEARCH } from '../icons';
import type { KnownToolDefinition } from '../_types';

export const providerSearchTools = {
    // Gemini internal tools - should be hidden (minimal)
    'search': {
        title: t('tools.names.search'),
        icon: ICON_SEARCH,
        minimal: true,
        input: z.object({
            items: z.array(z.any()).optional(),
            locations: z.array(z.any()).optional()
        }).partial().loose()
    },
} satisfies Record<string, KnownToolDefinition>;

