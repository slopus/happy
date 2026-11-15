import * as z from "zod";

export const MESSAGE_REACTIONS = ["👍", "👎", "❤️", "😂", "🎉", "😮"] as const;
export const MessageReactionSchema = z.enum(MESSAGE_REACTIONS);
export type MessageReaction = z.infer<typeof MessageReactionSchema>;
