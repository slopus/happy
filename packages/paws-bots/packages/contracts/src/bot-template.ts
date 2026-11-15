import * as z from "zod";
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BotSchema,
} from "./domain.js";

const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64);

/**
 * A reviewed, ready-made bot: instructions, skills and routines that install paused, plus the
 * apps it works best with. Strict, and with no field for keys, memory, history, models or
 * servers, so a template cannot carry anything personal or secret.
 */
export const BotTemplateSchema = z.strictObject({
  id: slug,
  /** Bumped on any content change, so a create from an older preview is refused. */
  version: z.number().int().positive(),
  name: z.string().min(1).max(BOT_NAME_MAX_LENGTH),
  /** One line. */
  summary: z.string().min(1).max(120),
  /** Markdown: an example of what the bot sends, shown before anything is created. */
  sample: z.string().min(1).max(2000),
  description: z.string().max(BOT_DESCRIPTION_MAX_LENGTH),
  instructions: z.string().min(1).max(BOT_INSTRUCTIONS_MAX_LENGTH),
  skills: z
    .array(
      z.strictObject({
        // Words a routine can mention as `@Name`.
        name: z
          .string()
          .regex(/^[A-Za-z][\w-]*(?: [A-Za-z][\w-]*){0,5}$/)
          .max(64),
        description: z.string().min(1).max(2000),
        body: z.string().min(1).max(20_000),
      }),
    )
    .max(5),
  routines: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(80),
        prompt: z.string().min(1).max(4000),
        crons: z.array(z.string().min(1)).min(1).max(5),
      }),
    )
    .max(5),
  /** Connection catalog slugs; the bot asks for any that are missing and works without them. */
  apps: z.array(slug).max(6),
});
export type BotTemplate = z.infer<typeof BotTemplateSchema>;

export const BotTemplateListingSchema = BotTemplateSchema.extend({
  /** The bot an earlier create made, while it exists. */
  botId: z.string().nullable(),
});
export type BotTemplateListing = z.infer<typeof BotTemplateListingSchema>;

export const CreateBotFromTemplateInput = z.strictObject({
  templateId: slug,
  /** The version the user saw. */
  version: z.number().int().positive(),
  /** The bot's name as the preview showed it, in the user's language. */
  name: z.string().trim().min(1).max(BOT_NAME_MAX_LENGTH).optional(),
});

export const CreateBotFromTemplateOutput = z.object({
  bot: BotSchema,
  /** False when the template's bot already existed and was returned instead. */
  created: z.boolean(),
});

/** Import keys a template's bot is recorded under; agent imports cannot use them. */
export const BOT_TEMPLATE_IMPORT_KEY_PREFIX = "template:";

/** Sent as the error's `data.reason` when the template changed after it was shown. */
export const BOT_TEMPLATE_CHANGED = "template_changed";

export function isBotTemplateChanged(error: unknown): boolean {
  const data = error && typeof error === "object" && "data" in error ? error.data : undefined;
  return Boolean(
    data && typeof data === "object" && "reason" in data && data.reason === BOT_TEMPLATE_CHANGED,
  );
}
