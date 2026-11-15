import * as z from "zod";

/**
 * A routine that starts "when something changes". A checker, not a model,
 * takes a fingerprint of the watched thing on an interval; the routine only
 * runs when the fingerprint differs from the last one.
 *
 * - `files`: paths on the bot's computer (relative paths resolve into the
 *   bot's own folder). Names, sizes and modified times are compared.
 * - `command`: a shell command on the bot's computer; its output is the
 *   fingerprint. It runs every interval in the bot's folder, without a model
 *   or per-run approval, equivalent to the bot running the command itself.
 *   A non-zero exit is a failed check.
 * - `tool`: a read-only tool from a connected integration, called with fixed
 *   arguments; its result is the fingerprint.
 * - `http`: a public HTTPS endpoint, checked with GET without a computer.
 *   No custom headers, credentials, request body, or redirects are supported.
 *
 * `track` (tool, command, and http) narrows a JSON result to its items: objects that
 * carry the first field are compared by the listed fields only, so a fetch
 * time or a snippet does not count as a change, and the note can say which
 * items are new, updated or gone.
 */
export const ROUTINE_WATCH_KINDS = ["files", "command", "tool", "http"] as const;
export const ROUTINE_WATCH_DEFAULT_MINUTES = 15;
/** Keep unattended checks from hammering computers or connected services. */
export const ROUTINE_WATCH_MIN_MINUTES = 5;

export const RoutineWatchSchema = z
  .object({
    kind: z.enum(ROUTINE_WATCH_KINDS),
    paths: z.array(z.string().trim().min(1).max(500)).min(1).max(20).optional(),
    command: z.string().trim().min(1).max(2000).optional(),
    tool: z.string().trim().min(1).max(200).optional(),
    url: z.string().trim().min(1).max(2000).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    track: z.array(z.string().trim().min(1).max(100)).min(1).max(5).optional(),
    everyMinutes: z
      .number()
      .int()
      .min(ROUTINE_WATCH_MIN_MINUTES)
      .max(1440)
      .default(ROUTINE_WATCH_DEFAULT_MINUTES),
    /** Post "No changes" in chat on every quiet check, not only in history. */
    loud: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "files" && !value.paths?.length) {
      ctx.addIssue({ code: "custom", message: "Add a file or folder to watch", path: ["paths"] });
    }
    if (value.kind === "command" && !value.command) {
      ctx.addIssue({ code: "custom", message: "Add a command to run", path: ["command"] });
    }
    if (value.kind === "files" && value.track) {
      ctx.addIssue({
        code: "custom",
        message: "Tracked fields apply to a command, tool, or HTTP endpoint",
        path: ["track"],
      });
    }
    if (value.kind === "tool") {
      if (!value.tool) {
        ctx.addIssue({ code: "custom", message: "Pick a tool to check", path: ["tool"] });
      }
    }
    if (value.kind === "http") {
      let valid = false;
      try {
        const url = new URL(value.url ?? "");
        valid =
          url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.port;
      } catch {
        // Invalid URLs are reported with the same field error as other unsupported destinations.
      }
      if (!valid) {
        ctx.addIssue({ code: "custom", message: "Enter an HTTPS URL", path: ["url"] });
      }
    }
  });
export type RoutineWatch = z.infer<typeof RoutineWatchSchema>;
export type RoutineWatchInput = z.input<typeof RoutineWatchSchema>;

export const ROUTINE_WATCH_OUTCOMES = ["baseline", "unchanged", "changed", "failed"] as const;

/** What the last check saw. Written by the checker, never by clients. */
export const RoutineWatchStateSchema = z.object({
  checkedAt: z.string(),
  outcome: z.enum(ROUTINE_WATCH_OUTCOMES),
  /** An ongoing HTTP retry outage; absent after success or a permanent pause. */
  retrying: z.boolean().optional(),
  fingerprint: z.string().nullable(),
  /**
   * files: path -> "size:mtime"; tracked items: identity -> their tracked fields and title.
   * Kept so a change can be described, not just detected.
   */
  entries: z.record(z.string(), z.string()).optional(),
  /** What changed, or why the check failed, in a sentence or a short list. */
  detail: z.string().nullable(),
});
export type RoutineWatchState = z.infer<typeof RoutineWatchStateSchema>;
