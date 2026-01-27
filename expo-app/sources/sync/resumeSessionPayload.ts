import { z } from 'zod';
import { AGENT_IDS, type AgentId } from '@/agents/catalog';
import { isPermissionMode, type PermissionMode } from '@/sync/permissionTypes';

export type ResumeHappySessionRpcParams = {
    type: 'resume-session';
    sessionId: string;
    directory: string;
    agent: AgentId;
    resume?: string;
    sessionEncryptionKeyBase64: string;
    sessionEncryptionVariant: 'dataKey';
    permissionMode?: PermissionMode;
    permissionModeUpdatedAt?: number;
    experimentalCodexResume?: boolean;
    experimentalCodexAcp?: boolean;
};

const ResumeHappySessionRpcParamsSchema = z.object({
    type: z.literal('resume-session'),
    sessionId: z.string().min(1),
    directory: z.string().min(1),
    agent: z.enum(AGENT_IDS),
    resume: z.string().min(1).optional(),
    sessionEncryptionKeyBase64: z.string().min(1),
    sessionEncryptionVariant: z.literal('dataKey'),
    permissionMode: z.string().refine((value) => isPermissionMode(value)).optional(),
    permissionModeUpdatedAt: z.number().optional(),
    experimentalCodexResume: z.boolean().optional(),
    experimentalCodexAcp: z.boolean().optional(),
});

export function buildResumeHappySessionRpcParams(input: Omit<ResumeHappySessionRpcParams, 'type'>): ResumeHappySessionRpcParams {
    const params: ResumeHappySessionRpcParams = {
        type: 'resume-session',
        ...input,
    };
    // Validate shape early to avoid accidentally sending secrets in wrong fields.
    ResumeHappySessionRpcParamsSchema.parse(params);
    return params;
}
