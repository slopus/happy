import { z } from 'zod';

export const CODEX_AUTH_MAX_BYTES = 64 * 1024;
export const CODEX_GRANT_TTL_MS = 60_000;
const opaqueId = z.string().min(1).max(256);
const version = z.number().int().nonnegative().max(2_147_483_646);
const oauthToken = z.string().min(1).max(24_000).refine((s) => s.trim().length > 0);

// No passthrough: a new Codex credential format must be reviewed explicitly.
export const codexAuthSchema = z.object({
    auth_mode: z.literal('chatgpt').optional(),
    OPENAI_API_KEY: z.null().optional(),
    tokens: z.object({
        id_token: oauthToken,
        access_token: oauthToken,
        refresh_token: oauthToken,
        account_id: z.string().min(1).max(256).refine((s) => s.trim() === s && s.length > 0),
    }).strict(),
    last_refresh: z.string().datetime({ offset: true }).nullable().optional(),
}).strict().refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= CODEX_AUTH_MAX_BYTES);

export type CodexAuth = z.infer<typeof codexAuthSchema>;
export const uploadCodexAccountSchema = z.object({ auth: codexAuthSchema }).strict();
export type UploadCodexAccountRequest = z.infer<typeof uploadCodexAccountSchema>;
export const renameCodexAccountSchema = z.object({ displayName: z.string().trim().min(1).max(80).refine((s) => !/[\u0000-\u001f\u007f]/.test(s)) }).strict();
export type RenameCodexAccountRequest = z.infer<typeof renameCodexAccountSchema>;
export const bindCodexAccountSchema = z.object({ profileId: z.string().uuid().nullable(), expectedVersion: version }).strict();
export type BindCodexAccountRequest = z.infer<typeof bindCodexAccountSchema>;
export const createCodexGrantSchema = z.object({ machineId: opaqueId, sourceSessionId: opaqueId.optional() }).strict();
export type CreateCodexGrantRequest = z.infer<typeof createCodexGrantSchema>;
export const redeemCodexGrantSchema = z.object({ machineId: opaqueId, grant: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export type RedeemCodexGrantRequest = z.infer<typeof redeemCodexGrantSchema>;
export const registerCodexSessionSchema = z.object({ machineId: opaqueId, sourceSessionId: opaqueId }).strict();
export type RegisterCodexSessionRequest = z.infer<typeof registerCodexSessionSchema>;
export const updateCodexCredentialSchema = z.object({ machineId: opaqueId, launchId: z.string().uuid(), expectedVersion: version.positive(), auth: codexAuthSchema }).strict();
export type UpdateCodexCredentialRequest = z.infer<typeof updateCodexCredentialSchema>;
export const reportCodexQuotaSchema = z.object({
    machineId: opaqueId, launchId: z.string().uuid(), sourceSessionId: opaqueId,
    credentialVersion: version.positive(), weeklyUsedPercent: z.number().min(0).max(100),
    weeklyResetsAt: z.string().datetime({ offset: true }), observedAt: z.string().datetime({ offset: true }),
}).strict();
export type ReportCodexQuotaRequest = z.infer<typeof reportCodexQuotaSchema>;
// A quota probe is an explicitly user-requested, short-lived Codex invocation.
// It deliberately has no Happy conversation to attach to.
export const reportCodexQuotaProbeSchema = z.object({
    machineId: opaqueId, launchId: z.string().uuid(), credentialVersion: version.positive(),
    weeklyUsedPercent: z.number().min(0).max(100),
    weeklyResetsAt: z.string().datetime({ offset: true }), observedAt: z.string().datetime({ offset: true }),
}).strict();
export type ReportCodexQuotaProbeRequest = z.infer<typeof reportCodexQuotaProbeSchema>;
export const reportCodexStatusSchema = z.object({
    machineId: opaqueId, launchId: z.string().uuid(), credentialVersion: version.positive(),
    status: z.enum(['needs-refresh', 'invalid']),
}).strict();
export type ReportCodexStatusRequest = z.infer<typeof reportCodexStatusSchema>;

export interface CodexQuotaView {
    state: 'unknown' | 'current' | 'stale' | 'reset';
    remainingPercent: number | null;
    weeklyResetsAt: string | null;
    observedAt: string | null;
}
export interface CodexAccountProfileView {
    id: string;
    displayName: string;
    status: 'available' | 'needs-refresh' | 'invalid';
    credentialVersion: number;
    createdAt: string;
    updatedAt: string;
    lastValidatedAt: string | null;
    quota: CodexQuotaView;
}
export interface CodexMachineBinding { machineId: string; profileId: string | null; version: number }
export interface ListCodexAccountsResponse { profiles: CodexAccountProfileView[]; bindings: CodexMachineBinding[]; migration: 'none' | 'completed' | 'needs-upload' }
export interface CodexAccountMutationResponse { profile: CodexAccountProfileView }
export interface BindCodexAccountResponse { binding: CodexMachineBinding }
export interface CreateCodexGrantResponse { grant: string; expiresAt: string; profile: { id: string; displayName: string; credentialVersion: number } }
// This response is daemon-only. Never reuse it in list / App-facing endpoints.
export interface RedeemCodexGrantResponse { auth: CodexAuth; launchId: string; profile: { id: string; displayName: string; credentialVersion: number } }
export interface CodexSuccessResponse { success: true }
export interface ReportCodexQuotaResponse { accepted: boolean }
