import { z } from 'zod';

/** Optional rich presentation; the text event remains readable by older clients. */
export const asyncQuestionSchema = z.object({
  title: z.string().trim().min(1).max(20000),
  options: z.array(z.string().trim().min(1).max(20000)).min(1).max(100).optional(),
});
export const asyncQuestionsSchema = z.array(asyncQuestionSchema).min(1).max(100);
export type AsyncQuestion = z.infer<typeof asyncQuestionSchema>;

export const asyncQuestionResponseSchema = z.object({
  status: z.enum(['sending', 'answered', 'dismissed', 'uncertain']),
  answers: z.array(z.string().max(20000)).max(100).optional(),
  updatedAt: z.number(),
  requestId: z.string().optional(),
});
export type AsyncQuestionResponse = z.infer<typeof asyncQuestionResponseSchema>;

export const asyncQuestionActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('answer'), itemId: z.string().min(1).max(512), answers: z.array(z.string().trim().min(1).max(20000)).min(1).max(100) }),
  z.object({ action: z.literal('dismiss'), itemId: z.string().min(1).max(512) }),
]);
export type AsyncQuestionAction = z.infer<typeof asyncQuestionActionSchema>;

/** Invalid rich metadata must never hide an otherwise readable message. */
export function getAsyncQuestions(delivery: unknown, questions: unknown): AsyncQuestion[] | undefined {
  if (delivery !== 'async') return undefined;
  const parsed = asyncQuestionsSchema.safeParse(questions);
  return parsed.success ? parsed.data : undefined;
}
