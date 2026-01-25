import { describe, expect, it } from 'vitest';

import type { PermissionMode } from '@/api/types';
import { MessageQueue2 } from '@/utils/MessageQueue2';

import { waitForNextOpenCodeMessage } from './waitForNextOpenCodeMessage';

describe('waitForNextOpenCodeMessage', () => {
    it('wakes on metadata update and then processes a pending-queue item', async () => {
        const queue = new MessageQueue2<{ permissionMode: PermissionMode }>(() => 'hash');

        let pendingText: string | null = null;
        const session = {
            popPendingMessage: async () => {
                if (!pendingText) return false;
                const text = pendingText;
                pendingText = null;
                queue.pushImmediate(text, { permissionMode: 'default' });
                return true;
            },
            waitForMetadataUpdate: async (abortSignal?: AbortSignal) => {
                if (abortSignal?.aborted) return false;
                return await new Promise<boolean>((resolve) => {
                    const timer = setTimeout(() => resolve(true), 0);
                    timer.unref?.();
                });
            },
        };

        const abortController = new AbortController();
        pendingText = 'from-pending';

        const result = await waitForNextOpenCodeMessage({
            messageQueue: queue,
            abortSignal: abortController.signal,
            session: session as any,
        });

        expect(result?.message).toBe('from-pending');
    });
});

