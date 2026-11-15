import { jsonrepair } from "jsonrepair";
import type { z } from "zod";

/**
 * Models wrap JSON in prose or fences and break its syntax; repair it before checking the shape.
 * The candidate runs from the first "{" to the last "}", so a later object cut off mid-reply is
 * dropped silently; callers that act on the result must check the whole reply themselves.
 */
export function parseModelJson<T extends z.ZodType>(
  text: string,
  schema: T,
): z.infer<T> | undefined {
  const candidate = text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return undefined;
  try {
    const result = schema.safeParse(JSON.parse(jsonrepair(candidate)));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
