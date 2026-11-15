import type { z } from "zod";

/** A tool call's argument problems, on one line. */
export function argsError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
    .join(" ");
}
