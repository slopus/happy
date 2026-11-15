import { TimeZoneSchema } from "@rakazo/contracts";
import { z } from "zod";
import type { RunContext } from "./run-context.js";
import { isRunTainted, refuseOwnerSettingsChange } from "./run-context.js";
import { isSubagentToolExecution } from "./run-effects.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { changeUserTimezone } from "./schedule-tools.js";

const PreferencesPatchSchema = z
  .object({ timezone: TimeZoneSchema.optional(), marketingEmails: z.boolean().optional() })
  .strict();

async function updatePreferences(ctx: RunContext, call: ToolCall) {
  const { deps, run, source } = ctx;
  if (!source.ownerStartedRun)
    return call.finish({ error: "Account preferences change only in a chat the user started." });
  const parsed = PreferencesPatchSchema.safeParse(call.args);
  if (!parsed.success)
    return call.finish({
      error: parsed.error.issues
        .map((issue) =>
          issue.code === "unrecognized_keys"
            ? `Only timezone and marketingEmails can change here; ${issue.keys.join(", ")} stay in the app's settings.`
            : `${issue.path.join(".")}: ${issue.message}`,
        )
        .join(" "),
    });
  const { timezone, marketingEmails } = parsed.data;
  const write = timezone !== undefined || marketingEmails !== undefined;
  if (write && isSubagentToolExecution(call.executionId))
    return call.finish({ error: "Helpers cannot change account preferences." });
  // The owner already approved the change itself; its replay runs in a later attempt.
  const approved = call.nextApprovedTool === "update_preferences";
  if (write && !approved && (await isRunTainted(ctx)))
    return call.finish(
      refuseOwnerSettingsChange(
        ctx,
        "Account preferences are blocked for the rest of this run because it read outside content.",
      ),
    );
  const select = { timezone: true, marketingEmailOptOutAt: true } as const;
  let user: { timezone: string | null; marketingEmailOptOutAt: Date | null };
  if (!write) {
    user = await deps.prisma.user.findUniqueOrThrow({ where: { id: run.userId }, select });
  } else if (timezone !== undefined) {
    // The routines that took the account zone keep their local schedule in the new zone,
    // and the email preference commits in the same save.
    await changeUserTimezone(
      deps,
      run.userId,
      timezone,
      marketingEmails === undefined
        ? undefined
        : { marketingEmailOptOutAt: marketingEmails ? null : new Date() },
    );
    user = await deps.prisma.user.findUniqueOrThrow({ where: { id: run.userId }, select });
  } else {
    user = await deps.prisma.user.update({
      where: { id: run.userId },
      data: { marketingEmailOptOutAt: marketingEmails ? null : new Date() },
      select,
    });
  }
  return call.finish({
    timezone: user.timezone,
    marketingEmails: user.marketingEmailOptOutAt === null,
  });
}

/** The account preferences of the user who started the run. */
export const preferenceTools: ToolHandlers = { update_preferences: updatePreferences };
