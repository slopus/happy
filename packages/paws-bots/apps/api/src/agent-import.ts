import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { AgentImportSettings, ImportedMcpServer } from "@rakazo/adapters";
import {
  BUILTIN_AGENT_SKILLS,
  isCatalogModelChoice,
  readAgentImportSettings,
  readGrokBotImportSettings,
} from "@rakazo/adapters";
import type {
  Actor,
  AgentImportCreateInput,
  AgentImportErrorReason,
  AgentImportFile,
  AgentImportMemoryDestination,
  AgentImportPlan,
  AgentImportSetupItem,
  AgentImportSetupState,
  AgentImportWarning,
  Bot,
  BotAvatarSet,
  CreateRoutineInput as CreateRoutineInputType,
  McpServerConfigInput,
  MessageBlock,
} from "@rakazo/contracts";
import {
  BOT_INSTRUCTIONS_MAX_LENGTH,
  CreateRoutineInput,
  isValidTimeZone,
  MEMORY_INDEX_PATH,
} from "@rakazo/contracts";
import type { SkillFiles } from "@rakazo/core";
import {
  combineImportedInstructions,
  parseAgentImport,
  readAgentImportFolder,
  readGrokBotExportJson,
  renameRoutineSkillMentions,
  resolveAgentImportNames,
} from "@rakazo/core";
import type { McpServer as McpServerRow, Prisma, PrismaClient, Routine } from "@rakazo/db";
import {
  appendEventInTransaction,
  availableInSpace,
  createThreadMessageInTransaction,
  isUniqueViolation,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

type Reader = Pick<Prisma.TransactionClient, "memoryDocument" | "agentSkill" | "mcpServer">;
type Stored = Awaited<ReturnType<SecretStore["put"]>> | null;

/**
 * The router's own write paths, so imported settings are validated, encrypted and scheduled
 * exactly as when added by hand.
 */
export type AgentImportServices<PreparedKey = unknown> = {
  prisma: PrismaClient;
  createBot: (
    actor: Actor,
    input: {
      name: string;
      description: string;
      instructions: string;
      notifyOnFinish: boolean;
      color?: string;
      avatarSet?: BotAvatarSet;
      computerMode: AgentImportCreateInput["computerMode"];
      modelProvider: string | null;
      modelId: string | null;
      seed: (tx: Prisma.TransactionClient, botId: string) => Promise<void>;
    },
  ) => Promise<Bot>;
  hasModelConnection: (actor: Actor, provider: string) => Promise<boolean>;
  /** Decrypted only to tell set from blank; never returned to a client. */
  mcpCredentialValues: (
    actor: Actor,
    server: { id: string; secretId: string },
  ) => Promise<{ headers: Record<string, string>; env: Record<string, string> } | null>;
  connectedProviders: (actor: Actor, providers: string[]) => Promise<Set<string>>;
  /** `bots.update`'s model check; an error message or null. */
  validateBotModel: (actor: Actor, provider: string, modelId: string) => Promise<string | null>;
  /** Which stdio commands this actor may import; only admins add stdio servers. */
  stdioAllowed: (actor: Actor) => Promise<(command: string) => boolean>;
  /** `models.connect`'s checks and encryption for a key, without writing it. */
  prepareModelKey: (
    actor: Actor,
    input: { provider: string; apiKey: string; modelId?: string },
    signal?: AbortSignal,
  ) => Promise<PreparedKey>;
  /** Create-only: null, and nothing written, when the provider is already connected. */
  writeModelKey: (
    tx: Prisma.TransactionClient,
    actor: Actor,
    prepared: PreparedKey,
  ) => Promise<{ id: string; secretId: string; provider: string } | null>;
  afterModelKey: (provider: string) => void;
  prepareMcpServer: (actor: Actor, input: McpServerConfigInput) => Promise<Stored>;
  insertMcpServer: (
    tx: Prisma.TransactionClient,
    actor: Actor,
    input: McpServerConfigInput,
    stored: Stored,
  ) => Promise<McpServerRow>;
  findBot: (actor: Actor, botId: string) => Promise<Bot | null>;
  assertRoutineSchedule: (input: CreateRoutineInputType) => void;
  routineNextRunAt: (input: CreateRoutineInputType) => Date | null;
  routineRowData: (
    actor: Actor,
    input: CreateRoutineInputType,
    nextRunAt: Date | null,
  ) => Prisma.RoutineUncheckedCreateInput;
  announceRoutine: (
    actor: Actor,
    bot: { id: string; thread: { id: string } | null },
    row: Routine,
  ) => Promise<void>;
  notifyThread: (threadId: string, seq: number) => Promise<void>;
};

/** What the setup checklist checks for each imported MCP server. */
type ImportRecord = {
  /**
   * `credentials`/`env`: names that need values before the server works (its checklist);
   * `unverifiable`: it also needs a program or local paths, which cannot be checked.
   */
  mcpServers: {
    id: string;
    credentials?: string[];
    env?: string[];
    unverifiable?: boolean;
  }[];
};

const BLOCKING: ReadonlySet<AgentImportWarning> = new Set(["unsupported_command"]);

function parsePlan(files: AgentImportFile[], skillFiles: SkillFiles): AgentImportPlan {
  const plan = parseAgentImport(files, skillFiles);
  if ("error" in plan) throw new ORPCError("BAD_REQUEST", { message: plan.error });
  return plan;
}

async function takenNames(db: Reader, actor: Actor) {
  const owner = { spaceId: actor.spaceId, userId: actor.userId };
  const documents = await db.memoryDocument.findMany({
    where: { ...owner, scope: "user", botId: null },
    select: { path: true },
  });
  // Names already taken here include the owner's items from other spaces that reach this one.
  const skills = await db.agentSkill.findMany({
    where: availableInSpace(actor),
    select: { name: true },
  });
  const servers = await db.mcpServer.findMany({
    where: availableInSpace(actor),
    select: { slug: true },
  });
  return {
    spaceMemoryPaths: documents.map((document) => document.path),
    skillNames: [...skills, ...BUILTIN_AGENT_SKILLS].map((skill) => skill.name),
    mcpSlugs: servers.map((server) => server.slug),
  };
}

export type Built = {
  plan: AgentImportPlan;
  settings: (AgentImportSettings & { keyValues: Map<string, string> }) | null;
  routineInputs: Map<string, CreateRoutineInputType>;
  mcpConfigs: Map<string, ImportedMcpServer & { slug: string }>;
  connectedKeyIds: Set<string>;
};

/** Key values stay in `settings.keyValues` and never enter the plan. */
async function buildPlan(
  services: AgentImportServices,
  actor: Actor,
  input: { files: AgentImportFile[]; includeSecrets: boolean; skillFiles: SkillFiles },
): Promise<Built> {
  const { files, includeSecrets } = input;
  const base = parsePlan(files, input.skillFiles);
  const taken = await takenNames(services.prisma, actor);
  const plan = resolveAgentImportNames(base, taken);
  const routineInputs = new Map<string, CreateRoutineInputType>();
  const mcpConfigs = new Map<string, ImportedMcpServer & { slug: string }>();
  const connectedKeyIds = new Set<string>();
  let settings: Built["settings"];
  if (base.source === "grok_bot") {
    // parsePlan has checked that this file holds exactly one Bot.
    const [bot] = readGrokBotExportJson(files[0]?.content ?? "");
    settings = bot ? readGrokBotImportSettings(bot) : null;
  } else {
    const folder =
      base.source === "document" ? null : readAgentImportFolder(files, { includeSecrets });
    settings = folder
      ? readAgentImportSettings(folder, {
          includeSecrets,
          stdioAllowed: await services.stdioAllowed(actor),
        })
      : null;
  }
  if (!settings) return { plan, settings: null, routineInputs, mcpConfigs, connectedKeyIds };

  let model: AgentImportPlan["model"] = null;
  if (settings.model) {
    const { title, provider, providerName, modelId, known } = settings.model;
    const usable = (await services.validateBotModel(actor, provider, modelId)) === null;
    const status = usable ? "ready" : known ? "needs_key" : "unknown";
    model = { id: "model", title, provider, providerName, modelId, status };
  }

  const skipped = [...plan.skipped, ...settings.skipped];
  const apiKeys: AgentImportPlan["apiKeys"] = [];
  for (const key of settings.apiKeys) {
    if (await services.hasModelConnection(actor, key.provider)) {
      skipped.push({ path: key.source, reason: "connected" });
      connectedKeyIds.add(key.id);
    } else {
      apiKeys.push({ id: key.id, title: key.title, provider: key.provider });
    }
  }

  const slugs = new Set(taken.mcpSlugs);
  const mcpServers = settings.mcpServers.map((server) => {
    const slug = freeSlug(server.config.slug, slugs);
    mcpConfigs.set(server.id, { ...server, slug });
    return {
      id: server.id,
      title: server.title,
      name: slug,
      content: server.content,
      warnings: server.warnings,
      status: server.status,
    };
  });

  const originalSkillNames = new Map(base.skills.map((skill) => [skill.id, skill.name]));
  const previewSkillNames = new Map<string, string>([
    ...taken.skillNames.map((name): [string, string] => [name, name]),
    ...plan.skills.flatMap((skill): [string, string][] => {
      const original = originalSkillNames.get(skill.id);
      return original ? [[original, skill.name]] : [];
    }),
  ]);
  const fallbackZone = await savedTimeZone(services.prisma, actor);
  const routines = settings.routines.flatMap((routine) => {
    const timezone = routine.timezone ?? fallbackZone;
    const parsed = CreateRoutineInput.safeParse({
      // Replaced by the new bot's id when the routine is written.
      botId: "pending",
      name: routine.name,
      prompt: routine.prompt,
      crons: [routine.cron],
      timezone,
      active: false,
    });
    if (!parsed.success) {
      const file = base.source === "grok_bot" ? "routines" : "cron/jobs.json";
      skipped.push({ path: `${file}: ${routine.title}`, reason: "unsupported" });
      return [];
    }
    routineInputs.set(routine.id, parsed.data);
    return [
      {
        id: routine.id,
        title: routine.title,
        content: `${routine.cron} (${timezone})\n\n${renameRoutineSkillMentions(routine.prompt, previewSkillNames)}`,
        warnings: routine.warnings,
        status: { kind: "needs_setup" as const, needs: [{ kind: "turn_on" as const }] },
      },
    ];
  });

  return {
    plan: { ...plan, model, mcpServers, routines, apiKeys, skipped },
    settings,
    routineInputs,
    mcpConfigs,
    connectedKeyIds,
  };
}

/** The user's saved time zone, for routines that don't name one. */
export async function savedTimeZone(prisma: PrismaClient, actor: Actor): Promise<string> {
  const saved = (
    await prisma.user.findUnique({ where: { id: actor.userId }, select: { timezone: true } })
  )?.timezone;
  return saved && isValidTimeZone(saved) ? saved : "UTC";
}

export async function previewAgentImport(
  services: AgentImportServices,
  actor: Actor,
  input: { files: AgentImportFile[]; includeSecrets: boolean; skillFiles: SkillFiles },
): Promise<AgentImportPlan> {
  return (await buildPlan(services, actor, input)).plan;
}

/** In plan order; unknown or repeated ids are refused. */
function selected<
  T extends { id: string; warnings?: AgentImportWarning[]; status?: { kind: string } },
>(items: T[], ids: string[]): T[] {
  const known = new Set(items.map((item) => item.id));
  const chosen = new Set(ids);
  if (chosen.size !== ids.length || ids.some((id) => !known.has(id))) {
    throw refused("BAD_REQUEST", "selection_mismatch", "The selection does not match the files.");
  }
  const picked = items.filter((item) => chosen.has(item.id));
  if (picked.some((item) => item.warnings?.some((warning) => BLOCKING.has(warning)))) {
    throw refused("BAD_REQUEST", "cannot_run_here", "That MCP server cannot run here.");
  }
  if (picked.some((item) => item.status?.kind === "unsupported")) {
    throw refused("BAD_REQUEST", "cannot_run_here", "That item cannot work here.");
  }
  return picked;
}

/**
 * Re-reads the files (nothing is staged between preview and create), runs every check and
 * encryption, then writes everything and the import record in one transaction.
 */
export async function createImportedBot<PreparedKey>(
  services: AgentImportServices<PreparedKey>,
  actor: Actor,
  input: AgentImportCreateInput,
  signal?: AbortSignal,
): Promise<Bot> {
  const { importKey, ...request } = input;
  const written = await writeImportedBot(
    services,
    actor,
    {
      ...input,
      digest: requestDigest(request),
      build: () => buildPlan(services as AgentImportServices, actor, input),
    },
    signal,
  );
  return written.bot;
}

/** A bot to create from a plan: an import's files or a template build it. */
export type ImportedBotRequest = Pick<
  AgentImportCreateInput,
  "importKey" | "selection" | "name" | "description" | "computerMode" | "color" | "avatarSet"
> & {
  /** Of the request without its key: reusing a key for another request is refused. */
  digest: string;
  build: () => Promise<Built>;
  /** Posted before the checklist, such as cards for apps the bot works with. */
  cards?: MessageBlock[];
  /** Runs first in the create's transaction. */
  beforeWrite?: (tx: Prisma.TransactionClient) => Promise<void>;
};

/** `created` is false when the key's earlier create is returned instead. */
export async function writeImportedBot<PreparedKey>(
  services: AgentImportServices<PreparedKey>,
  actor: Actor,
  input: ImportedBotRequest,
  signal?: AbortSignal,
): Promise<{ bot: Bot; created: boolean }> {
  const owner = { spaceId: actor.spaceId, userId: actor.userId };
  const { importKey, digest } = input;
  const already = async () => {
    if (!importKey) return null;
    const found = await services.prisma.agentImport.findFirst({
      where: { ...owner, importKey },
      select: { botId: true, requestDigest: true },
    });
    if (!found) return null;
    if (found.requestDigest !== digest) {
      throw refused(
        "PRECONDITION_FAILED",
        "import_reused",
        "This import was already used with different files or choices.",
      );
    }
    return services.findBot(actor, found.botId);
  };
  const retried = await already();
  if (retried) return { bot: retried, created: false };
  const { plan, settings, routineInputs, mcpConfigs, connectedKeyIds } = await input.build();
  const instructions = combineImportedInstructions(
    selected(plan.instructions, input.selection.instructions),
  );
  if (instructions.length > BOT_INSTRUCTIONS_MAX_LENGTH) {
    throw refused(
      "BAD_REQUEST",
      "instructions_too_long",
      `Instructions can be at most ${BOT_INSTRUCTIONS_MAX_LENGTH} characters. Import fewer files.`,
    );
  }
  const destinations = new Map<string, AgentImportMemoryDestination>(
    input.selection.memory.map((choice) => [choice.id, choice.destination]),
  );
  const memoryIds = selected(
    plan.memory,
    input.selection.memory.map((choice) => choice.id),
  ).map((item) => item.id);
  const skillIds = selected(plan.skills, input.selection.skills).map((item) => item.id);
  const servers = selected(plan.mcpServers, input.selection.mcpServers).map(
    (item) => mcpConfigs.get(item.id)!,
  );
  const routines = selected(plan.routines, input.selection.routines).map(
    (item) => routineInputs.get(item.id)!,
  );
  // A key whose provider was connected after the preview is still selected; skip it.
  if (new Set(input.selection.apiKeys).size !== input.selection.apiKeys.length) {
    throw refused("BAD_REQUEST", "selection_mismatch", "The selection does not match the files.");
  }
  const keys = selected(
    plan.apiKeys,
    input.selection.apiKeys.filter((id) => !connectedKeyIds.has(id)),
  );
  const model = input.selection.model ? plan.model : null;
  if (input.selection.model) {
    const keyed = keys.some((key) => key.provider === model?.provider);
    const usable =
      model?.status === "ready" ||
      (model?.status === "needs_key" &&
        keyed &&
        isCatalogModelChoice(model.provider, model.modelId));
    if (!model || !usable) {
      throw refused("BAD_REQUEST", "model_needs_key", "Connect this model's provider first.");
    }
  }
  for (const routine of routines) {
    services.assertRoutineSchedule(routine);
    services.routineNextRunAt(routine);
  }

  // A key for the chosen model's provider is checked against that model too.
  const preparedKeys: PreparedKey[] = [];
  for (const key of keys) {
    if (await services.hasModelConnection(actor, key.provider)) continue;
    const apiKey = settings?.keyValues.get(key.provider);
    if (!apiKey) continue;
    preparedKeys.push(
      await services
        .prepareModelKey(
          actor,
          {
            provider: key.provider,
            apiKey,
            modelId: model?.provider === key.provider ? model.modelId : undefined,
          },
          signal,
        )
        .catch((error: unknown) => {
          throw keyCheckFailure(error, key.title);
        }),
    );
  }
  const preparedServers: { id: string; config: McpServerConfigInput; stored: Stored }[] = [];
  for (const server of servers) {
    // A server renamed to avoid a clash keeps one name everywhere: its name is the new slug.
    const renamed = server.slug !== server.config.slug;
    const config = {
      ...server.config,
      slug: server.slug,
      ...(renamed ? { name: server.slug } : {}),
    };
    preparedServers.push({
      id: server.id,
      config,
      stored: await services.prepareMcpServer(actor, config),
    });
  }

  const record: ImportRecord = { mcpServers: [] };
  const credentials: { provider: string }[] = [];
  const routineRows: Routine[] = [];
  const setup: AgentImportSetupItem[] = [];
  const added: { threadId: string; seq: number }[] = [];
  const announceAdded = async (
    tx: Prisma.TransactionClient,
    botId: string,
    message: { id: string },
    threadId: string,
    blocks: MessageBlock[],
  ) => {
    const event = await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId,
      botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    added.push({ threadId, seq: event.seq });
  };
  const write = async (tx: Prisma.TransactionClient, botId: string) => {
    // A serialization conflict runs this again: start each attempt clean.
    for (const list of [record.mcpServers, credentials, routineRows, setup, added]) {
      list.length = 0;
    }
    await input.beforeWrite?.(tx);
    for (const prepared of preparedKeys) {
      const credential = await services.writeModelKey(tx, actor, prepared);
      if (credential) credentials.push(credential);
    }
    // The preview may be stale: names are resolved again under the creation lock.
    const taken = await takenNames(tx, actor);
    const resolved = resolveAgentImportNames(plan, taken);
    const memory = resolved.memory
      .filter((item) => memoryIds.includes(item.id))
      .sort((left, right) => curatedRank(left.path) - curatedRank(right.path));
    // Agent context reads newest memory first within a budget: curated documents get the
    // newest times, set explicitly rather than left to clock ticks.
    const now = Date.now();
    for (const [index, item] of memory.entries()) {
      const updatedAt = new Date(now - (memory.length - 1 - index));
      const toBot = destinations.get(item.id) === "bot";
      const path = toBot ? item.path : item.spacePath;
      const seeded =
        toBot && path === MEMORY_INDEX_PATH
          ? await tx.memoryDocument.findFirst({
              where: { ...owner, scope: "bot", botId, path },
              select: { id: true },
            })
          : null;
      const document = seeded
        ? await tx.memoryDocument.update({
            where: { id: seeded.id },
            data: { content: item.content, updatedAt },
          })
        : await tx.memoryDocument.create({
            data: {
              ...owner,
              scope: toBot ? "bot" : "user",
              botId: toBot ? botId : null,
              path,
              content: item.content,
              updatedAt,
            },
          });
      await tx.memoryRevision.create({
        data: { documentId: document.id, revision: document.revision, content: item.content },
      });
    }
    for (const item of resolved.skills.filter((skill) => skillIds.includes(skill.id))) {
      const row = await tx.agentSkill
        .create({
          data: {
            ...owner,
            name: item.name,
            description: item.description,
            content: item.content,
            source: "user",
          },
        })
        .catch(conflict("A skill with that name was just added. Try again."));
      if (item.status.kind === "needs_setup") {
        setup.push({ kind: "skill", name: row.name, needs: item.status.needs });
      }
    }
    // Imported servers are not given to the bot; an approval card lets the user grant them.
    const thread = await tx.thread.findFirstOrThrow({
      where: { ...owner, botId },
      select: { id: true },
    });
    const slugs = new Set(
      (await tx.mcpServer.findMany({ where: availableInSpace(actor), select: { slug: true } })).map(
        (row) => row.slug,
      ),
    );
    for (const prepared of preparedServers) {
      const slug = freeSlug(prepared.config.slug, slugs);
      const config = {
        ...prepared.config,
        slug,
        ...(slug !== prepared.config.slug ? { name: slug } : {}),
      };
      const row = await services
        .insertMcpServer(tx, actor, config, prepared.stored)
        .catch(conflict("An MCP server with that name was just added. Try again."));
      const card: MessageBlock[] = [
        {
          kind: "mcp_approval",
          name: row.name,
          serverId: row.id,
          transport: config.transport,
          endpoint: row.endpoint,
          needsOAuth: false,
          status: "pending",
        },
      ];
      const cardMessage = await createThreadMessageInTransaction(tx, {
        threadId: thread.id,
        role: "bot",
        blocks: card,
      });
      await announceAdded(tx, botId, cardMessage, thread.id, card);
      const status = plan.mcpServers.find((item) => item.id === prepared.id)?.status;
      const named = (kind: "credentials" | "env") =>
        status?.kind === "needs_setup"
          ? status.needs.flatMap((need) => (need.kind === kind ? need.names : []))
          : [];
      record.mcpServers.push({
        id: row.id,
        credentials: named("credentials"),
        env: named("env"),
        unverifiable:
          status?.kind === "needs_setup" &&
          status.needs.some((need) => need.kind === "program" || need.kind === "local_paths"),
      });
      if (status?.kind === "needs_setup") {
        setup.push({ kind: "mcp", serverId: row.id, name: row.slug, needs: status.needs });
      }
    }
    // A skill renamed on a clash keeps its routines: `@garden` follows it to `garden-2`.
    // Every known name is matched, so `@garden tools` is never read as `@garden`.
    const originalNames = new Map(plan.skills.map((item) => [item.id, item.title]));
    const renamed = new Map<string, string>([
      ...taken.skillNames.map((name): [string, string] => [name, name]),
      ...resolved.skills.flatMap((item): [string, string][] => {
        const from = originalNames.get(item.id);
        return from ? [[from, skillIds.includes(item.id) ? item.name : from]] : [];
      }),
    ]);
    for (const routine of routines) {
      const routineInput = {
        ...routine,
        botId,
        prompt: renameRoutineSkillMentions(routine.prompt, renamed),
      };
      const row = await tx.routine.create({
        data: services.routineRowData(actor, routineInput, services.routineNextRunAt(routineInput)),
      });
      routineRows.push(row);
      setup.push({ kind: "routine", routineId: row.id, name: row.name });
    }
    if (plan.model?.status === "needs_key" && !model) {
      setup.push({
        kind: "model",
        title: plan.model.title,
        provider: plan.model.provider,
        providerName: plan.model.providerName,
      });
    }
    if (input.cards?.length) {
      const message = await createThreadMessageInTransaction(tx, {
        threadId: thread.id,
        role: "bot",
        blocks: input.cards,
      });
      await announceAdded(tx, botId, message, thread.id, input.cards);
    }
    if (setup.length) {
      const checklist: MessageBlock[] = [{ kind: "import_setup", items: setup }];
      const message = await createThreadMessageInTransaction(tx, {
        threadId: thread.id,
        role: "bot",
        blocks: checklist,
      });
      await announceAdded(tx, botId, message, thread.id, checklist);
    }
    await tx.agentImport.create({
      data: {
        ...owner,
        botId,
        source: plan.source,
        importKey: importKey ?? null,
        requestDigest: digest,
        created: record as unknown as Prisma.InputJsonValue,
      },
    });
  };
  let bot: Bot;
  try {
    bot = await services.createBot(actor, {
      name: input.name,
      description: input.description,
      instructions,
      notifyOnFinish: true,
      color: input.color,
      avatarSet: input.avatarSet,
      computerMode: input.computerMode,
      modelProvider: model?.provider ?? null,
      modelId: model?.modelId ?? null,
      seed: write,
    });
  } catch (error) {
    // Two requests with one import key: the second's transaction lost the race.
    const winner = isUniqueViolation(error) ? await already() : null;
    if (!winner) throw error;
    return { bot: winner, created: false };
  }
  const settle = (label: string) => (error: unknown) => {
    getLogger().error(label, error);
  };
  // Nothing may fail the import after its commit: failures are logged and left to the
  // existing recovery. MCP servers are not probed before the user approves them.
  for (const credential of credentials) {
    try {
      services.afterModelKey(credential.provider);
    } catch (error) {
      settle("imported key catalog refresh")(error);
    }
  }
  for (const event of added) {
    await services.notifyThread(event.threadId, event.seq).catch(settle("imported card notice"));
  }
  const thread = bot.threadId ? { id: bot.threadId } : null;
  for (const row of routineRows) {
    await services
      .announceRoutine(actor, { id: bot.id, thread }, row)
      .catch(settle("imported routine notice"));
  }
  return { bot, created: true };
}

/** Only the actor's own rows are read; unknown ids are not done. */
export async function agentImportSetupState(
  services: AgentImportServices,
  actor: Actor,
  input: { botId: string; providers: string[]; serverIds: string[]; routineIds: string[] },
): Promise<AgentImportSetupState> {
  const owner = { spaceId: actor.spaceId, userId: actor.userId };
  const db = services.prisma;
  const [servers, assigned, routines, imports] = await Promise.all([
    db.mcpServer.findMany({
      where: { ...owner, id: { in: input.serverIds } },
      select: { id: true, secretId: true },
    }),
    db.botMcpServer.findMany({
      where: { ...owner, botId: input.botId, serverId: { in: input.serverIds } },
      select: { serverId: true },
    }),
    db.routine.findMany({
      where: { botId: input.botId, id: { in: input.routineIds }, bot: owner },
      select: { id: true, active: true },
    }),
    db.agentImport.findMany({ where: { ...owner, botId: input.botId }, select: { created: true } }),
  ]);
  const needed = new Map(
    imports.flatMap((row) =>
      (row.created as unknown as ImportRecord).mcpServers.map(
        (server) => [server.id, server] as const,
      ),
    ),
  );
  const given = new Set(assigned.map((row) => row.serverId));
  const nonBlank = (value: string | undefined) => typeof value === "string" && value.trim() !== "";
  // Approval alone is not setup: every value the server was shown to need must be stored.
  const serverState = async (id: string): Promise<AgentImportSetupState["serverIds"][string]> => {
    const row = servers.find((server) => server.id === id);
    const need = needed.get(id);
    if (!row || !need || !Array.isArray(need.credentials) || !Array.isArray(need.env)) {
      return false;
    }
    if (need.unverifiable) return "unverifiable";
    if (!given.has(id)) return false;
    if (need.credentials.length === 0 && need.env.length === 0) return true;
    const values = row.secretId
      ? await services.mcpCredentialValues(actor, { id: row.id, secretId: row.secretId })
      : null;
    if (!values) return false;
    return (
      need.credentials.every((name) => nonBlank(values.headers[name])) &&
      need.env.every((name) => nonBlank(values.env[name]))
    );
  };
  const serverIds = [...new Set(input.serverIds)];
  const serverStates = Object.fromEntries(
    await Promise.all(serverIds.map(async (id) => [id, await serverState(id)] as const)),
  );
  const providers = [...new Set(input.providers)];
  const connected = await services.connectedProviders(actor, providers);
  return {
    providers: Object.fromEntries(providers.map((provider) => [provider, connected.has(provider)])),
    serverIds: serverStates,
    routineIds: Object.fromEntries(
      input.routineIds.map((id) => [id, routines.some((row) => row.id === id && row.active)]),
    ),
  };
}

/** Every list in a create request is a set, so keys and lists are sorted before hashing. */
export function requestDigest(request: unknown): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value
          .map((item) => JSON.stringify(canonical(item)))
          .sort()
          .map((item) => JSON.parse(item) as unknown)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
          )
        : value;
  return createHash("sha256")
    .update(JSON.stringify(canonical(request)))
    .digest("hex");
}

/** The provider's own error text is never passed on: it can echo details of the request. */
function keyCheckFailure(error: unknown, providerName: string) {
  if (signalAborted(error)) return error;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const reason: AgentImportErrorReason = message.includes("rejected")
    ? "key_rejected"
    : message.includes("could not verify")
      ? "key_unverified"
      : "key_check_failed";
  return new ORPCError("BAD_REQUEST", {
    message: `The ${providerName} API key could not be connected.`,
    data: { reason, provider: providerName },
  });
}

function signalAborted(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function refused(
  code: "BAD_REQUEST" | "CONFLICT" | "NOT_FOUND" | "PRECONDITION_FAILED",
  reason: AgentImportErrorReason,
  message: string,
) {
  return new ORPCError(code, { message, data: { reason } });
}

function conflict(message: string) {
  return (error: unknown): never => {
    if (isUniqueViolation(error)) throw refused("CONFLICT", "name_just_taken", message);
    throw error;
  };
}

function freeSlug(slug: string, used: Set<string>): string {
  let candidate = slug;
  for (let n = 2; used.has(candidate); n += 1) {
    const tail = `-${n}`;
    candidate = `${slug.slice(0, 64 - tail.length)}${tail}`;
  }
  used.add(candidate);
  return candidate;
}

/** Daily logs and other notes first (in plan order, oldest first), then USER.md, then MEMORY.md. */
function curatedRank(path: string): number {
  return path === MEMORY_INDEX_PATH ? 2 : path === "USER.md" ? 1 : 0;
}
