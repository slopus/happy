import type { ConnectorTool } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { listSchedulesFromTool } from "./schedule-tools.js";
import { listScratchpadItems } from "./scratchpad-tools.js";
import { listAgentSkillRecords } from "./skill-tools.js";

export type TaskCatalogToolDeps = {
  prisma: PrismaClient;
};

type TaskCatalogInput = {
  spaceId: string;
  botId: string;
  userId: string;
  /** In a group run, marks which routines post in the group. */
  groupThreadId?: string;
  tools: readonly Pick<ConnectorTool, "name" | "description" | "readOnly">[];
};

/**
 * Guidance injected alongside the catalog tool. Keep this short: the live
 * records returned by task_catalog are the source of truth for names and ids.
 */
export const TASK_CATALOG_GUIDANCE = [
  "Task execution: task_catalog is the source of truth for this bot's open work, routines, skills, and exposed tools; conversation or memory text is not proof that a task exists.",
  "When a request refers to an existing task, routine, skill, or capability, call task_catalog first and use the exact returned id/name.",
  "For an open task, perform the work with the exposed tools, verify the result, then use scratchpad_update or scratchpad_complete. Never mark work done before verification.",
  "For a schedule, provide exactly one timing mode to schedule_create (cron, every+unit, runAt, delayMinutes, or delaySeconds), then call schedule_list and only report success when the routine is present. Change an existing routine with schedule_update, not cancel and recreate, and report the timing it returns.",
  "If a tool returns an error, do not repeat the same tool call with the same arguments. Correct the specific field once as a separate attempt; if that attempt fails, stop and explain the blocker instead of narrating more retries. A different command is not a retry.",
].join("\n");

export async function taskCatalogFromTool(deps: TaskCatalogToolDeps, input: TaskCatalogInput) {
  const [tasks, schedules, taughtSkills, skills] = await Promise.all([
    listScratchpadItems(deps, {
      spaceId: input.spaceId,
      botId: input.botId,
      includeDone: false,
    }),
    listSchedulesFromTool(deps, {
      spaceId: input.spaceId,
      botId: input.botId,
      ...(input.groupThreadId ? { groupThreadId: input.groupThreadId } : {}),
    }),
    deps.prisma.taughtSkill.findMany({
      where: {
        spaceId: input.spaceId,
        botId: input.botId,
        status: "saved",
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: { id: true, name: true, goal: true, status: true },
    }),
    listAgentSkillRecords(deps.prisma, {
      spaceId: input.spaceId,
      userId: input.userId,
    }),
  ]);

  const seenTools = new Set<string>();
  const exposedTools = input.tools.flatMap((tool) => {
    if (seenTools.has(tool.name)) return [];
    seenTools.add(tool.name);
    return [
      {
        name: tool.name,
        description: tool.description,
        readOnly: tool.readOnly ?? false,
      },
    ];
  });

  return {
    guidance: TASK_CATALOG_GUIDANCE,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      notes: task.notes,
      source: "scratchpad",
    })),
    routines: schedules.routines,
    ...(schedules.note ? { routinesNote: schedules.note } : {}),
    taughtSkills: taughtSkills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      goal: skill.goal,
      status: skill.status,
      source: "taught_skill",
    })),
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      readOnly: skill.readOnly,
    })),
    tools: exposedTools,
  };
}
