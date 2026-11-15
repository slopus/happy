import { FEEDBACK_DESCRIPTION_MAX_LENGTH, FEEDBACK_KINDS } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import { z } from "zod";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

const FeedbackSchema = z
  .object({
    kind: z.enum(FEEDBACK_KINDS),
    description: z.string().trim().min(1).max(FEEDBACK_DESCRIPTION_MAX_LENGTH),
  })
  .strict();

/** Enough for a user reporting a few problems; stops a looping bot from filing dozens. */
export const FEEDBACK_REPORTS_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

async function sendFeedback(ctx: RunContext, call: ToolCall) {
  const { deps, run } = ctx;
  const parsed = FeedbackSchema.safeParse(call.args);
  if (!parsed.success)
    return call.finish({
      error: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .join(" "),
    });
  const recent = await deps.prisma.feedbackReport.count({
    where: { userId: run.userId, createdAt: { gte: new Date(Date.now() - HOUR_MS) } },
  });
  if (recent >= FEEDBACK_REPORTS_PER_HOUR)
    return call.finish({ error: "Too many reports in the last hour. Try again later." });
  const report = await deps.prisma.feedbackReport.create({
    data: {
      userId: run.userId,
      spaceId: run.spaceId,
      botId: run.botId,
      threadId: run.threadId,
      runId: run.id,
      kind: parsed.data.kind,
      description: redactSecrets(parsed.data.description, ctx.secrets),
    },
    select: { id: true },
  });
  return call.finish({ sent: true, id: report.id });
}

/** Bug reports and product feedback the user asked their bot to send. */
export const feedbackTools: ToolHandlers = { feedback: sendFeedback };
