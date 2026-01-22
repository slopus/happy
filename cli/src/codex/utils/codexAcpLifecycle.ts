import { randomUUID } from 'node:crypto';
import type { ACPMessageData } from '@/api/apiSession';

export function nextCodexLifecycleAcpMessages(params: {
  currentTaskId: string | null;
  msg: unknown;
}): { currentTaskId: string | null; messages: ACPMessageData[] } {
  const { currentTaskId, msg } = params;

  if (!msg || typeof msg !== 'object') {
    return { currentTaskId, messages: [] };
  }

  const type = (msg as any).type;

  if (type === 'task_started') {
    const id = currentTaskId ?? randomUUID();
    return { currentTaskId: id, messages: [{ type: 'task_started', id }] };
  }

  if (type === 'task_complete') {
    const id = currentTaskId ?? randomUUID();
    return { currentTaskId: null, messages: [{ type: 'task_complete', id }] };
  }

  if (type === 'turn_aborted') {
    const id = currentTaskId ?? randomUUID();
    return { currentTaskId: null, messages: [{ type: 'turn_aborted', id }] };
  }

  return { currentTaskId, messages: [] };
}
