import { z } from "zod";

export const SIGNUP_ATTRIBUTION_COOKIE = "rakazo_signup_attribution";
export const SIGNUP_SURFACE_HEADER = "x-rakazo-signup-surface";
export const SignupSurface = z.enum(["web", "desktop", "ios", "android"]);

// Campaign labels only: never URLs, query strings, email addresses, or click identifiers.
const campaignLabel = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9 ._~-]*$/);
export const SignupAttribution = z
  .object({
    surface: SignupSurface.optional(),
    utmSource: campaignLabel.optional(),
    utmMedium: campaignLabel.optional(),
    utmCampaign: campaignLabel.optional(),
    utmContent: campaignLabel.optional(),
    utmTerm: campaignLabel.optional(),
    referringDomain: z
      .string()
      .max(253)
      .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/)
      .optional(),
  })
  .strict();
export type SignupAttribution = z.infer<typeof SignupAttribution>;
