import { z } from "zod";
import {
  BILLING_CANCELLATION_REASONS,
  ByokIntervalSchema,
  ByokTierSchema,
  PlanLayoutSchema,
} from "./billing.js";
import { SIGNUP_SURVEY_TEAM_SIZES, SIGNUP_SURVEY_USES } from "./domain.js";
import { RUN_ERROR_KINDS, RunTriggerSchema } from "./runs.js";
import { SignupAttribution } from "./signup-attribution.js";

// Explicitly validated fields only: this is also the final allowlist at the external boundary.
export const AnalyticsScreen = z.enum([
  "home",
  "chat",
  "onboarding",
  "settings",
  "integrations",
  "artifacts",
  "board",
  "computer",
  "search",
  "bot_profile",
  "routine",
  "new_bot",
  "plans",
]);
export const AnalyticsSurface = z.enum(["web", "desktop", "ios", "android"]);
export const AnalyticsScreenInput = z
  .object({
    screen: AnalyticsScreen,
    surface: AnalyticsSurface,
    /** On the plans screen: the layout it showed. */
    planLayout: PlanLayoutSchema.optional(),
  })
  .strict();
export const AnalyticsBotSetting = z.enum([
  "name",
  "description",
  "instructions",
  "avatar",
  "notifications",
  "memory",
  "voice",
  "auto_speak",
  "model",
  "thinking",
  "computer",
  "team_chat",
  "cross_space",
  "daily_check_ins",
  "fleet_management",
  "reply_mode",
  "tools",
]);
export const AnalyticsTrigger = RunTriggerSchema;
/** A coarse failure class; "other" covers everything without a known kind. Never the error text. */
export const AnalyticsErrorKind = z.enum([...RUN_ERROR_KINDS, "other"]);
export const AnalyticsModelConnectMethod = z.enum(["api_key", "oauth", "credits", "compatible"]);
const modelConnect = {
  method: AnalyticsModelConnectMethod,
  // A model catalog provider id, checked against the fixed catalog by the caller.
  provider: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
    .optional(),
};
export const AnalyticsPlan = z.enum(["own_key", "credits"]);
/** A paid plan and what it bills each period; credits bill monthly and have no tier. */
const planTerms = {
  plan: AnalyticsPlan,
  tier: ByokTierSchema.optional(),
  interval: ByokIntervalSchema,
  amountCents: z.number().int().positive(),
};
export const AnalyticsEvent = z.discriminatedUnion("name", [
  SignupAttribution.extend({ name: z.literal("account_created") }).strict(),
  z.object({ name: z.literal("signed_in") }).strict(),
  z.object({ name: z.literal("screen_viewed"), ...AnalyticsScreenInput.shape }).strict(),
  z.object({ name: z.literal("message_sent"), trigger: AnalyticsTrigger }).strict(),
  z.object({ name: z.literal("run_started"), trigger: AnalyticsTrigger }).strict(),
  z.object({ name: z.literal("run_completed"), trigger: AnalyticsTrigger }).strict(),
  z
    .object({
      name: z.literal("run_failed"),
      trigger: AnalyticsTrigger,
      errorKind: AnalyticsErrorKind,
    })
    .strict(),
  z.object({ name: z.literal("model_connect_started"), ...modelConnect }).strict(),
  z.object({ name: z.literal("model_connected"), ...modelConnect }).strict(),
  z
    .object({
      name: z.literal("model_connect_failed"),
      ...modelConnect,
      errorKind: AnalyticsErrorKind,
    })
    .strict(),
  // A manual edit in bot settings; which setting only, never its value.
  z.object({ name: z.literal("bot_setting_changed"), setting: AnalyticsBotSetting }).strict(),
  // Only the fixed choices; free-text answers stay in the database.
  z
    .object({
      name: z.literal("signup_survey_answered"),
      skipped: z.boolean(),
      use: z.enum(SIGNUP_SURVEY_USES).optional(),
      teamSize: z.enum(SIGNUP_SURVEY_TEAM_SIZES).optional(),
    })
    .strict(),
  z.object({ name: z.literal("checkout_opened"), ...planTerms }).strict(),
  z.object({ name: z.literal("subscription_started"), ...planTerms, trial: z.boolean() }).strict(),
  // A trial's end: its first payment, or access lost without one.
  z.object({ name: z.literal("trial_ended"), ...planTerms, converted: z.boolean() }).strict(),
  // Only the fixed reason; the comment stays in the database.
  z
    .object({
      name: z.literal("subscription_cancel_feedback"),
      reason: z.enum(BILLING_CANCELLATION_REASONS).optional(),
      commented: z.boolean(),
    })
    .strict(),
]);
export type AnalyticsEvent = z.infer<typeof AnalyticsEvent>;

export type AnalyticsScreen = z.infer<typeof AnalyticsScreen>;
export type AnalyticsErrorKind = z.infer<typeof AnalyticsErrorKind>;
export type AnalyticsBotSetting = z.infer<typeof AnalyticsBotSetting>;
export type AnalyticsModelConnectMethod = z.infer<typeof AnalyticsModelConnectMethod>;
