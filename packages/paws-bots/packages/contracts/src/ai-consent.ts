import * as z from "zod";
import { SettingsScopeSchema } from "./settings-scope.js";

export const AI_DISCLOSURE_VERSION = "2026-11-12";
export const AI_PRIVACY_URL = "https://rakazo.com/privacy/";
export const AiDataUseSchema = z.enum(["model", "voice", "memory"]);
export type AiDataUse = z.infer<typeof AiDataUseSchema>;
export const AiConsentQuerySchema = z
  .object({
    botId: z.string().optional(),
    groupId: z.string().optional(),
    routineId: z.string().optional(),
    uses: z.array(AiDataUseSchema).optional(),
    /** Which copy of the member's settings names the recipients; omitted means the one that applies. */
    settingsScope: SettingsScopeSchema.optional(),
  })
  .default({});
export type AiConsentQuery = z.infer<typeof AiConsentQuerySchema>;
export const AiRecipientSchema = z.object({
  key: z.string(),
  name: z.string(),
  use: AiDataUseSchema,
  detail: z.string(),
  privacyUrl: z.string().url().optional(),
  allowed: z.boolean(),
});
export type AiRecipient = z.infer<typeof AiRecipientSchema>;
export const AiConsentStatusSchema = z.object({
  scope: z.string(),
  version: z.string(),
  recipients: z.array(AiRecipientSchema),
  privacyUrl: z.string().url().optional(),
});
export type AiConsentStatus = z.infer<typeof AiConsentStatusSchema>;
export const AI_CONSENT_REQUIRED = "Review AI data sharing in Account settings before continuing.";
