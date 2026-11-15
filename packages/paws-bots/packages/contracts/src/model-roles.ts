import { z } from "zod";
import { Id, ThinkingLevelSchema } from "./ids.js";
import type { ModelCatalogEntry } from "./model-connections.js";
import { ModelBackupChoiceSchema, modelChoiceListSchema } from "./model-connections.js";

/** Add purposes here; connections, persistence, pickers and backups stay shared. */
export const ModelRoleSchema = z.enum(["main", "approval", "computer"]);
export type ModelRole = z.infer<typeof ModelRoleSchema>;
export const ModelRoleChoiceSchema = ModelBackupChoiceSchema.extend({
  thinkingLevel: ThinkingLevelSchema.nullable().optional(),
  /** The connection this row runs on; omitted rows use the provider's connection or the deployment's. */
  credentialId: Id.optional(),
});
export type ModelRoleChoice = z.infer<typeof ModelRoleChoiceSchema>;
export const ModelRoleSettingsSchema = z.object({
  primary: ModelRoleChoiceSchema.nullable(),
  backups: modelChoiceListSchema(ModelRoleChoiceSchema),
});
export type ModelRoleSettings = z.infer<typeof ModelRoleSettingsSchema>;
export const ModelRoleUpdateSchema = ModelRoleSettingsSchema.partial();
/** A member's choices plus what the deployment runs when they chose no model. */
export const ModelRoleViewSchema = ModelRoleSettingsSchema.extend({
  deploymentPrimary: ModelRoleChoiceSchema.nullable().optional(),
  /** Main role only: whether the model that runs reads images on the connection runs use. */
  seesImages: z.boolean().optional(),
});
export type ModelRoleView = z.infer<typeof ModelRoleViewSchema>;

export function modelSupportsRole(entry: ModelCatalogEntry, role: ModelRole): boolean {
  if (role === "approval") return true;
  return entry.protocol !== "decisions" && (role !== "computer" || entry.images !== false);
}
