/** Scheduled work must select an explicit native policy before either agent starts. */
import { z } from 'zod';
import type { PermissionMode } from '@/api/types';

export const SCHEDULED_PERMISSION_ENV = 'HAPPY_SCHEDULED_PERMISSION_MODE';
export function scheduledLaunchPermission(agent: 'codex' | 'claude', env: NodeJS.ProcessEnv = process.env): PermissionMode | undefined {
    const raw = env[SCHEDULED_PERMISSION_ENV];
    if (raw === undefined) return undefined;
    const mode = z.enum(['read-only', 'default', 'acceptEdits', 'plan']).parse(raw);
    if (agent === 'codex') return mode === 'plan' ? 'read-only' : mode === 'default' ? 'acceptEdits' : mode;
    return mode === 'read-only' ? 'plan' : mode;
}
export function assertScheduledRuntimeSupported(sandboxEnabled: boolean): void {
    if (sandboxEnabled) throw new Error('scheduled-sandbox-unsupported');
}
