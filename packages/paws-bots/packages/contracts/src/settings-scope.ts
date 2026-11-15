import { z } from "zod";

/** Member settings that follow the account unless a Space overrides them. */
export const SpaceSettingSchema = z.enum(["models", "voice", "confirmations", "credentials"]);
export type SpaceSetting = z.infer<typeof SpaceSettingSchema>;

/**
 * Which copy a settings call reads or writes: the account's, or the bound Space's override.
 * Omitted means whichever applies in the Space, which is what apps that predate overrides
 * read and write.
 */
export const SettingsScopeSchema = z.enum(["account", "space"]);
export type SettingsScope = z.infer<typeof SettingsScopeSchema>;

export const settingsScopeInput = z.object({ scope: SettingsScopeSchema.optional() });
