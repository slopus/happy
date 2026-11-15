import * as z from "zod";
import { Id } from "./ids.js";

export const SearchHitKindSchema = z.enum(["conversation", "message", "file", "link", "routine"]);
export type SearchHitKind = z.infer<typeof SearchHitKindSchema>;

export const SearchHitSchema = z
  .object({
    kind: SearchHitKindSchema,
    botId: Id.optional(),
    botName: z.string().optional(),
    groupId: Id.optional(),
    groupName: z.string().optional(),
    title: z.string(),
    snippet: z.string(),
    messageId: Id.optional(),
    seq: z.number().int().nonnegative().optional(),
    artifactId: Id.optional(),
    routineId: Id.optional(),
    url: z.string().optional(),
  })
  .superRefine((input, ctx) => {
    const hasBot = Boolean(input.botId);
    const hasGroup = Boolean(input.groupId);
    if (hasBot === hasGroup) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of botId or groupId",
        path: ["botId"],
      });
    }
  });
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchQueryOutputSchema = z.object({
  hits: z.array(SearchHitSchema).max(25),
});
export type SearchQueryOutput = z.infer<typeof SearchQueryOutputSchema>;
