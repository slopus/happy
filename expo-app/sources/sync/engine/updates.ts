import type { z } from 'zod';
import { ApiUpdateContainerSchema } from '../apiTypes';

type ApiUpdateContainer = z.infer<typeof ApiUpdateContainerSchema>;

export function parseUpdateContainer(update: unknown): ApiUpdateContainer | null {
    const validatedUpdate = ApiUpdateContainerSchema.safeParse(update);
    if (!validatedUpdate.success) {
        console.error('❌ Sync: Invalid update data:', update);
        return null;
    }
    return validatedUpdate.data;
}

export function inferTaskLifecycleFromMessageContent(content: unknown): { isTaskComplete: boolean; isTaskStarted: boolean } {
    const rawContent = content as { content?: { type?: string; data?: { type?: string } } } | null;
    const contentType = rawContent?.content?.type;
    const dataType = rawContent?.content?.data?.type;

    const isTaskComplete =
        (contentType === 'acp' || contentType === 'codex') &&
        (dataType === 'task_complete' || dataType === 'turn_aborted');

    const isTaskStarted = (contentType === 'acp' || contentType === 'codex') && dataType === 'task_started';

    return { isTaskComplete, isTaskStarted };
}

