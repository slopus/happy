import { ORPCError } from "@orpc/server";
import type {
  Actor,
  AgentImportPlan,
  BotTemplate,
  BotTemplateListing,
  ConnectionCatalogItem,
  CreateRoutineInput as CreateRoutineInputType,
  MessageBlock,
} from "@rakazo/contracts";
import {
  BOT_TEMPLATE_CHANGED,
  BOT_TEMPLATE_IMPORT_KEY_PREFIX,
  CreateRoutineInput,
} from "@rakazo/contracts";
import {
  appConnectCard,
  BOT_TEMPLATES,
  botTemplateApps,
  buildSkillMd,
  findBotTemplate,
  renameRoutineSkillMentions,
  renameSkillMd,
} from "@rakazo/core";
import { availableInSpace, Prisma } from "@rakazo/db";
import type { AgentImportServices, Built } from "./agent-import.js";
import { requestDigest, savedTimeZone, writeImportedBot } from "./agent-import.js";

/** One bot per template: creating it again returns the bot it made, until that bot is archived or deleted. */
function importKey(templateId: string): string {
  return `${BOT_TEMPLATE_IMPORT_KEY_PREFIX}${templateId}`;
}

export async function listBotTemplates(
  services: Pick<AgentImportServices, "prisma">,
  actor: Actor,
): Promise<BotTemplateListing[]> {
  const made = await services.prisma.agentImport.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      importKey: { in: BOT_TEMPLATES.map((template) => importKey(template.id)) },
      source: "template",
      bot: { archivedAt: null },
    },
    select: { importKey: true, botId: true },
  });
  const bots = new Map(made.map((row) => [row.importKey, row.botId]));
  return BOT_TEMPLATES.map((template) => ({
    ...template,
    botId: bots.get(importKey(template.id)) ?? null,
  }));
}

/** The same plan an agent import writes: instructions, skills, and routines that start paused. */
export function templatePlan(template: BotTemplate, timezone: string): Built {
  const routineInputs = new Map<string, CreateRoutineInputType>();
  const routines = template.routines.map((routine, index) => {
    const id = `routine-${index}`;
    routineInputs.set(
      id,
      CreateRoutineInput.parse({
        // Replaced by the new bot's id when the routine is written.
        botId: "pending",
        name: routine.name,
        prompt: routine.prompt,
        crons: routine.crons,
        timezone,
        active: false,
      }),
    );
    return {
      id,
      title: routine.name,
      content: `${routine.crons.join(", ")} (${timezone})\n\n${routine.prompt}`,
      warnings: [],
      status: { kind: "needs_setup" as const, needs: [{ kind: "turn_on" as const }] },
    };
  });
  const plan: AgentImportPlan = {
    source: "template",
    suggestedName: template.name,
    suggestedDescription: template.description,
    instructions: [
      {
        id: "instructions",
        title: template.name,
        content: template.instructions,
        role: "working",
        stock: false,
        mentions: [],
      },
    ],
    memory: [],
    skills: template.skills.map((skill) => ({
      id: skill.name,
      title: skill.name,
      name: skill.name,
      description: skill.description,
      content: buildSkillMd(skill),
      warnings: [],
      status: { kind: "ready" },
    })),
    model: null,
    mcpServers: [],
    routines,
    apiKeys: [],
    skipped: [],
  };
  return {
    plan,
    settings: null,
    routineInputs,
    mcpConfigs: new Map(),
    connectedKeyIds: new Set(),
  };
}

/** Cards for the template's apps that aren't connected yet; apps this server lacks are skipped. */
export function templateAppCards(
  template: BotTemplate,
  catalog: ConnectionCatalogItem[],
): MessageBlock[] {
  return botTemplateApps(template, catalog)
    .filter((entry) => !entry.connected)
    .map(appConnectCard);
}

/**
 * Creates the template's bot like an agent import: one transaction, paused routines, a setup
 * checklist, and cards for missing apps. Nothing is connected or run for the user.
 */
export async function createBotFromTemplate<PreparedKey>(
  services: AgentImportServices<PreparedKey>,
  appCatalog: () => Promise<ConnectionCatalogItem[]>,
  actor: Actor,
  input: { templateId: string; version: number; name?: string },
  signal?: AbortSignal,
) {
  const template = findBotTemplate(input.templateId);
  if (!template) throw new ORPCError("NOT_FOUND", { message: "No template has that id." });
  // Skills the plan reuses instead of adding, checked again when the bot is written.
  let reusedRows: { id: string; name: string; content: string }[] = [];
  const request: Parameters<typeof writeImportedBot>[2] = {
    importKey: importKey(template.id),
    // The same for every version, so an existing bot is returned whatever changed since.
    digest: requestDigest({ templateId: template.id }),
    name: input.name ?? template.name,
    description: template.description,
    computerMode: "team",
    selection: {
      instructions: ["instructions"],
      memory: [],
      skills: template.skills.map((skill) => skill.name),
      model: false,
      mcpServers: [],
      routines: template.routines.map((_, index) => `routine-${index}`),
      apiKeys: [],
    },
    build: async () => {
      if (template.version !== input.version) {
        throw new ORPCError("PRECONDITION_FAILED", {
          message: "This template changed. Look at it again before creating the bot.",
          data: { reason: BOT_TEMPLATE_CHANGED },
        });
      }
      request.cards = templateAppCards(template, template.apps.length ? await appCatalog() : []);
      const built = templatePlan(template, await savedTimeZone(services.prisma, actor));
      // A skill an earlier copy of this bot added, still unchanged (perhaps renamed on a clash),
      // is reused rather than added again; the routines' mentions are pointed at it.
      const kept = await services.prisma.agentSkill.findMany({
        where: {
          AND: [
            availableInSpace(actor),
            {
              OR: template.skills.map((skill) => ({
                name: { startsWith: skill.name, mode: "insensitive" as const },
              })),
            },
          ],
        },
        select: { id: true, name: true, content: true },
        orderBy: { createdAt: "asc" },
      });
      const reused = new Map<string, string>();
      reusedRows = [];
      for (const skill of template.skills) {
        const copy = new RegExp(`^${escapeRegExp(skill.name)}(?:-\\d+)?$`, "i");
        const row = kept.find(
          (item) =>
            copy.test(item.name) && item.content === renameSkillMd(buildSkillMd(skill), item.name),
        );
        if (row) {
          reused.set(skill.name, row.name);
          reusedRows.push(row);
        }
      }
      built.plan.skills = built.plan.skills.filter((skill) => !reused.has(skill.id));
      request.selection.skills = built.plan.skills.map((skill) => skill.id);
      for (const [id, routine] of built.routineInputs) {
        built.routineInputs.set(id, {
          ...routine,
          prompt: renameRoutineSkillMentions(routine.prompt, reused),
        });
      }
      return built;
    },
    // An archived bot no longer counts as the template's bot: its record makes way for the new
    // one, in the same transaction, so a failed create leaves the archived bot's record in place.
    beforeWrite: async (tx) => {
      // A reused skill stays as planned until the bot is written: deleting or editing it waits.
      if (reusedRows.length) {
        const locked = await tx.$queryRaw<{ id: string; name: string; content: string }[]>`
          SELECT id, name, content FROM agent_skills
          WHERE id IN (${Prisma.join(reusedRows.map((row) => row.id))}) FOR SHARE`;
        const unchanged = reusedRows.every((row) =>
          locked.some(
            (item) => item.id === row.id && item.name === row.name && item.content === row.content,
          ),
        );
        if (!unchanged) {
          throw new ORPCError("CONFLICT", {
            message: "A skill this bot uses just changed. Try again.",
            data: { reason: "skill_changed" },
          });
        }
      }
      await tx.agentImport.deleteMany({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          importKey: importKey(template.id),
          bot: { archivedAt: { not: null } },
        },
      });
    },
  };
  return writeImportedBot(services, actor, request, signal);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
