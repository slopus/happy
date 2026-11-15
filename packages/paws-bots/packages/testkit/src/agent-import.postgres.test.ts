import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EncryptedSecretStore, InMemoryRealtimeFanout } from "@rakazo/adapters";
import type { AgentImportPlan, Bot, MemoryDocument } from "@rakazo/contracts";
import { resolveEncryptionKey } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The app's own logger module (the API resolves `@rakazo/logging` to this file).
import { createLogger, createTestSink, installLogger } from "../../logging/src/index.js";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe : describe.skip;

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps.\n`;

const workspace = [
  { path: "workspace/SOUL.md", content: "Calm and direct.\n" },
  { path: "workspace/AGENTS.md", content: "Keep replies short.\n" },
  { path: "workspace/IDENTITY.md", content: "- **Name:** Pebble\n- **Vibe:** calm\n" },
  { path: "workspace/MEMORY.md", content: "Project Alpha ships in May.\n" },
  { path: "workspace/USER.md", content: "Prefers metric units.\n" },
  { path: "workspace/memory/2026-01-02.md", content: "Planned the week.\n" },
  { path: "workspace/TOOLS.md", content: "Local tool notes.\n" },
  { path: "workspace/skills/weekly-review/SKILL.md", content: skill("weekly-review", "Run it") },
  { path: "workspace/skills/watering/SKILL.md", content: skill("watering", "Water plants") },
  { path: "workspace/sessions/2026-01-02.md", content: "EXAMPLE_KEY=placeholder\n" },
];

/** An OpenClaw home shaped like the real one, with placeholder credentials. */
const settingsHome = [
  { path: ".openclaw/workspace/SOUL.md", content: "Calm and direct.\n" },
  {
    path: ".openclaw/openclaw.json",
    content: `{
      // JSON5, as written by OpenClaw
      agents: {
        entries: { main: { workspace: "/home/example/.openclaw/workspace" } },
        defaults: { model: { primary: "openrouter/anthropic/claude-sonnet-4.6" } },
      },
      gateway: { auth: { token: "placeholder-gateway-token" } },
      models: { providers: { anthropic: { apiKey: "\${ANTHROPIC_API_KEY}" } } },
      mcp: {
        servers: {
          docs: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer \${DOCS_TOKEN}" } },
          files: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
            env: { EXAMPLE_TOKEN: "placeholder-env-token" },
            toolFilter: { include: ["read_file"] },
          },
        },
      },
    }`,
  },
  {
    path: ".openclaw/.env",
    content: [
      "OPENROUTER_API_KEY=placeholder-openrouter-key",
      "ANTHROPIC_API_KEY=placeholder-anthropic-key",
      "DOCS_TOKEN=placeholder-docs-token",
      "TELEGRAM_BOT_TOKEN=placeholder-telegram-token",
    ].join("\n"),
  },
  {
    path: ".openclaw/cron/jobs.json",
    content: JSON.stringify({
      jobs: [
        {
          name: "heartbeat-main",
          declarationKey: "heartbeat:main",
          schedule: { kind: "every", everyMs: 1_800_000 },
          payload: { kind: "heartbeat" },
        },
        {
          name: "check",
          enabled: true,
          schedule: { kind: "every", everyMs: 1_800_000 },
          payload: { kind: "agentTurn", message: "Check the inbox" },
        },
        {
          name: "morning",
          enabled: false,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Kolkata" },
          payload: { kind: "agentTurn", message: "Summarise my day" },
        },
      ],
    }),
  },
];

/** Every change sent to open chats, as (topic, payload). */
const published: [string, string][] = [];
class RecordingRealtime extends InMemoryRealtimeFanout {
  override async publish(topic: string, payload: string) {
    published.push([topic, payload]);
    await super.publish(topic, payload);
  }
}

/** Runs once inside the next model key check: something the user does meanwhile. */
const keyCheck: { during: (() => Promise<void>) | null; status?: number } = { during: null };

describeIntegration("agent import", () => {
  let app: App;
  let db: PrismaClient;
  let stop: () => Promise<void>;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-agent-import-"));

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      realtime: new RecordingRealtime(),
      // Offline: key checks and MCP endpoint checks never leave the test.
      modelConnectionFetch: async () => {
        await keyCheck.during?.();
        return new Response("{}", { status: keyCheck.status ?? 200 });
      },
      remoteConnectors: {
        fetch: async () => new Response("", { status: 503 }),
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      },
    });
    app = handles.app;
    db = asSystem(handles.prisma);
    stop = handles.stop;
  });

  afterAll(async () => {
    await stop?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("previews, then creates the bot with only the chosen items and no overwrites", async () => {
    const cookie = await signup(app, `import-${stamp}@rakazo.test`, "Import User");
    const existingSkill = await rpc<{ id: string; content: string }>(
      app,
      cookie,
      "agentSkills/create",
      { content: skill("weekly-review", "Existing") },
    );
    const anyBot = await rpc<Bot>(app, cookie, "bots/create", { name: "Existing" });
    const owner = await db.bot.findUniqueOrThrow({
      where: { id: anyBot.id },
      select: { spaceId: true, userId: true },
    });
    const spaceUser = await db.memoryDocument.create({
      data: { ...owner, scope: "user", botId: null, path: "USER.md", content: "Existing.\n" },
    });

    const plan = await rpc<AgentImportPlan>(app, cookie, "bots/importPreview", {
      files: workspace,
    });
    expect(plan.source).toBe("openclaw");
    expect(plan.suggestedName).toBe("Pebble");
    expect(plan.skipped).toEqual([{ path: "TOOLS.md", reason: "runtime" }]);
    expect(plan.memory.find((item) => item.path === "USER.md")?.spacePath).toBe("USER-2.md");
    expect(plan.skills.map((item) => [item.title, item.name])).toEqual([
      ["watering", "watering"],
      ["weekly-review", "weekly-review-2"],
    ]);
    expect(JSON.stringify(plan)).not.toContain("EXAMPLE_KEY");

    const id = (title: string) =>
      [...plan.instructions, ...plan.memory, ...plan.skills].find((item) => item.title === title)!
        .id;
    const bot = await rpc<Bot>(app, cookie, "bots/importCreate", {
      files: workspace,
      name: "Pebble",
      description: plan.suggestedDescription,
      computerMode: "team",
      selection: {
        instructions: [id("AGENTS.md"), id("SOUL.md")],
        memory: [
          { id: id("MEMORY.md"), destination: "bot" },
          { id: id("USER.md"), destination: "space" },
        ],
        skills: [id("weekly-review")],
      },
    });
    // Each file keeps its purpose: the persona first, then how the bot works. IDENTITY.md
    // gives the name and description, not instructions.
    expect([bot.name, bot.description]).toEqual(["Pebble", "calm"]);
    expect(bot.instructions).toBe(
      "# Persona\n\nCalm and direct.\n\n# Working instructions\n\nKeep replies short.",
    );

    const botMemory = await db.memoryDocument.findMany({
      where: { botId: bot.id },
      include: { revisions: true },
      orderBy: { path: "asc" },
    });
    expect(botMemory.map((doc) => [doc.scope, doc.path, doc.content])).toEqual([
      ["bot", "MEMORY.md", "Project Alpha ships in May.\n"],
    ]);
    expect(botMemory[0]!.revisions.map((revision) => revision.content)).toEqual([
      "Project Alpha ships in May.\n",
    ]);

    const spaceMemory = await db.memoryDocument.findMany({
      where: { ...owner, scope: "user", botId: null, path: { in: ["USER.md", "USER-2.md"] } },
      include: { revisions: true },
      orderBy: { path: "asc" },
    });
    expect(spaceMemory.map((doc) => [doc.path, doc.content, doc.revisions.length])).toEqual([
      ["USER-2.md", "Prefers metric units.\n", 1],
      ["USER.md", "Existing.\n", 0],
    ]);
    expect(spaceMemory.find((doc) => doc.path === "USER.md")?.id).toBe(spaceUser.id);

    const skills = await db.agentSkill.findMany({ where: owner, orderBy: { name: "asc" } });
    expect(skills.map((row) => row.name)).toEqual(["weekly-review", "weekly-review-2"]);
    expect(skills[0]!.content).toBe(existingSkill.content);
    expect(skills.some((row) => row.name === "watering")).toBe(false);
    expect(
      await db.memoryDocument.count({ where: { ...owner, path: "memory/2026-01-02.md" } }),
    ).toBe(0);
  });

  it("creates nothing that runs or acts unless each one is selected", async () => {
    const cookie = await signup(app, `import-consent-${stamp}@rakazo.test`, "Consent User");
    const files = [
      ...settingsHome,
      { path: ".openclaw/skills/notes/SKILL.md", content: skill("notes", "Take notes") },
    ];
    const plan = await rpc<AgentImportPlan>(app, cookie, "bots/importPreview", { files });
    expect([plan.skills.length, plan.mcpServers.length, plan.routines.length]).toEqual([1, 2, 2]);
    // What an untouched Create sends: instructions only.
    const bot = await rpc<Bot>(app, cookie, "bots/importCreate", {
      files,
      name: "Untouched",
      selection: { instructions: plan.instructions.map((item) => item.id), memory: [], skills: [] },
    });
    const owner = await db.bot.findUniqueOrThrow({
      where: { id: bot.id },
      select: { spaceId: true, userId: true },
    });
    expect({
      skills: await db.agentSkill.count({ where: owner }),
      servers: await db.mcpServer.count({ where: owner }),
      routines: await db.routine.count({ where: owner }),
    }).toEqual({ skills: 0, servers: 0, routines: 0 });
    // Only the model is left to set up: its provider has no key here, so it was not applied.
    const blocks = (
      await db.message.findMany({ where: { thread: { botId: bot.id } }, select: { blocks: true } })
    ).flatMap((row) => row.blocks as { kind: string }[]);
    expect(blocks.filter((block) => block.kind === "import_setup")).toEqual([
      {
        kind: "import_setup",
        items: [
          {
            kind: "model",
            title: plan.model!.title,
            provider: plan.model!.provider,
            providerName: "OpenRouter",
          },
        ],
      },
    ]);
  });

  it("refuses unknown selections and oversized instructions without creating a bot", async () => {
    const cookie = await signup(app, `import-reject-${stamp}@rakazo.test`, "Reject User");
    const before = await rpc<Bot[]>(app, cookie, "bots/list", {});
    const unknown = await raw(app, cookie, "bots/importCreate", {
      files: workspace,
      name: "Nope",
      selection: { instructions: ["instructions:secret.md"], memory: [], skills: [] },
    });
    expect(unknown.status).toBe(400);
    const big = [
      { path: "workspace/SOUL.md", content: "x".repeat(15_000) },
      { path: "workspace/AGENTS.md", content: "y".repeat(15_000) },
    ];
    const plan = await rpc<AgentImportPlan>(app, cookie, "bots/importPreview", { files: big });
    const tooLong = await raw(app, cookie, "bots/importCreate", {
      files: big,
      name: "Nope",
      selection: { instructions: plan.instructions.map((item) => item.id), memory: [], skills: [] },
    });
    expect(tooLong.status).toBe(400);
    const unrecognised = await raw(app, cookie, "bots/importPreview", {
      files: [{ path: "notes.md", content: "Just notes.\n" }],
    });
    expect(unrecognised.status).toBe(400);
    expect(await rpc<Bot[]>(app, cookie, "bots/list", {})).toHaveLength(before.length);
  });

  it("keeps imported curated memory in the bot's context when daily logs are large", async () => {
    const cookie = await signup(app, `import-memory-${stamp}@rakazo.test`, "Memory User");
    const days = Array.from({ length: 5 }, (_, index) => ({
      path: `workspace/memory/2026-01-0${index + 1}.md`,
      content: `Day ${index + 1}. ${"Notes. ".repeat(1_500)}\n`,
    }));
    const files = [
      { path: "workspace/MEMORY.md", content: "Curated: Project Alpha ships in May.\n" },
      { path: "workspace/USER.md", content: "Curated: prefers metric units.\n" },
      ...days,
    ];
    expect(days.reduce((sum, day) => sum + day.content.length, 0)).toBeGreaterThan(32 * 1024);
    const plan = await rpc<AgentImportPlan>(app, cookie, "bots/importPreview", { files });
    const bot = await rpc<Bot>(app, cookie, "bots/importCreate", {
      files,
      name: "Memory",
      selection: {
        instructions: [],
        memory: plan.memory.map((item) => ({ id: item.id, destination: "bot" })),
        skills: [],
      },
    });

    const documents = await db.memoryDocument.findMany({ where: { botId: bot.id } });
    const updated = (path: string) =>
      documents.find((doc) => doc.path === path)!.updatedAt.getTime();
    const newestDay = Math.max(...days.map((day) => updated(day.path.slice("workspace/".length))));
    expect(updated("USER.md")).toBeGreaterThan(newestDay);
    expect(updated("MEMORY.md")).toBeGreaterThan(updated("USER.md"));
    expect(updated("memory/2026-01-05.md")).toBeGreaterThan(updated("memory/2026-01-01.md"));

    const { MarkdownMemoryStore } = await import("../../memory/src/index.ts");
    const { loadAgentMemoryContext } = await import("../../adapters/src/memory-context.ts");
    const owner = await db.bot.findUniqueOrThrow({
      where: { id: bot.id },
      select: { spaceId: true, userId: true },
    });
    const context = await loadAgentMemoryContext(new MarkdownMemoryStore(db), bot.id, {
      operationId: "agent-import-test",
      traceId: "agent-import-test",
      ...owner,
      signal: new AbortController().signal,
    });
    expect(context).toContain("Curated: Project Alpha ships in May.");
    expect(context).toContain("Curated: prefers metric units.");
  });

  it("imports model, MCP servers, routines and opted-in API keys through the existing paths", async () => {
    const cookie = await signup(app, `import-settings-${stamp}@rakazo.test`, "Settings User");
    const firstBot = await rpc<Bot>(app, cookie, "bots/create", { name: "First" });
    const owner = await db.bot.findUniqueOrThrow({
      where: { id: firstBot.id },
      select: { spaceId: true, userId: true },
    });
    await db.user.update({ where: { id: owner.userId }, data: { timezone: "Europe/Berlin" } });
    await rpc(app, cookie, "models/connect", {
      provider: "anthropic",
      apiKey: "placeholder-existing-key",
    });
    const existing = await db.userModelCredential.findFirstOrThrow({
      where: { userId: owner.userId, provider: "anthropic" },
    });

    const preview = await rpc<AgentImportPlan>(app, cookie, "bots/importPreview", {
      files: settingsHome,
    });
    expect(JSON.stringify(preview)).not.toContain("placeholder-");
    expect(preview.model).toEqual({
      id: "model",
      title: "openrouter/anthropic/claude-sonnet-4.6",
      provider: "openrouter",
      providerName: "OpenRouter",
      modelId: "anthropic/claude-sonnet-4.6",
      status: "needs_key",
    });
    expect(preview.apiKeys).toEqual([]);
    expect(preview.mcpServers.map((item) => [item.name, item.warnings])).toEqual([
      ["docs", []],
      // Stdio servers are disabled in this deployment, so this one cannot be created here.
      ["files", ["unsupported_command", "dropped_settings", "local_path"]],
    ]);
    expect(preview.routines.map((item) => [item.title, item.content])).toEqual([
      ["check", "*/30 * * * * (Europe/Berlin)\n\nCheck the inbox"],
      ["morning", "0 9 * * * (Asia/Kolkata)\n\nSummarise my day"],
    ]);
    expect(preview.skipped).toContainEqual({
      path: "cron/jobs.json: heartbeat-main",
      reason: "builtin",
    });

    const opted = await rpc<AgentImportPlan>(app, cookie, "bots/importPreview", {
      files: settingsHome,
      includeSecrets: true,
    });
    expect(JSON.stringify(opted)).not.toContain("placeholder-");
    expect(opted.apiKeys.map((item) => item.provider)).toEqual(["openrouter"]);
    expect(opted.skipped).toContainEqual({ path: "openclaw.json", reason: "connected" });

    expect(opted.model?.status).toBe("needs_key");

    // A model that cannot be used yet is refused before anything is written.
    const botsBefore = await db.bot.count({ where: owner });
    const refused = await raw(app, cookie, "bots/importCreate", {
      files: settingsHome,
      name: "Refused",
      selection: {
        instructions: [],
        memory: [],
        skills: [],
        model: true,
        mcpServers: ["mcp:docs"],
        routines: preview.routines.map((item) => item.id),
      },
    });
    expect(refused.status).toBe(400);
    const blocked = await raw(app, cookie, "bots/importCreate", {
      files: settingsHome,
      name: "Blocked",
      selection: { instructions: [], memory: [], skills: [], mcpServers: ["mcp:files"] },
    });
    expect(blocked.status).toBe(400);
    expect(await db.bot.count({ where: owner })).toBe(botsBefore);
    expect(await db.mcpServer.count({ where: owner })).toBe(0);
    expect(await db.routine.count({ where: owner })).toBe(0);

    // The space follows the account's models, so the main model is the account's.
    const mainModel = () =>
      db.userModelRoleChoice.findMany({
        where: { userId: owner.userId, role: "main", position: 0 },
      });
    expect((await mainModel()).map((row) => row.credentialId)).toEqual([existing.id]);

    const response = await raw(app, cookie, "bots/importCreate", {
      files: settingsHome,
      includeSecrets: true,
      name: "Settings",
      selection: {
        instructions: opted.instructions.map((item) => item.id),
        memory: [],
        skills: [],
        model: true,
        mcpServers: ["mcp:docs"],
        routines: opted.routines.map((item) => item.id),
        apiKeys: opted.apiKeys.map((item) => item.id),
      },
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("placeholder-");
    const bot = (JSON.parse(text) as { json: Bot }).json;
    expect([bot.modelProvider, bot.modelId]).toEqual(["openrouter", "anthropic/claude-sonnet-4.6"]);

    // Keys go through the connection path: encrypted, and an existing one is kept.
    const credentials = await db.userModelCredential.findMany({ where: { userId: owner.userId } });
    expect(credentials.map((row) => row.provider).sort()).toEqual(["anthropic", "openrouter"]);
    expect(credentials.find((row) => row.provider === "anthropic")?.secretId).toBe(
      existing.secretId,
    );
    // The imported key is added without switching the user's default model.
    expect((await mainModel()).map((row) => row.credentialId)).toEqual([existing.id]);
    const secrets = await db.secret.findMany({ where: { userId: owner.userId } });
    expect(secrets.length).toBeGreaterThan(0);
    for (const secret of secrets) expect(secret.ciphertext).not.toContain("placeholder-");

    const servers = await db.mcpServer.findMany({
      where: owner,
      include: { assignments: true },
      orderBy: { slug: "asc" },
    });
    // Like a server added in the MCP form with its credential left blank: nothing stored.
    expect(
      servers.map((row) => [row.slug, row.transport, row.headers, row.env, row.secretId]),
    ).toEqual([["docs", "streamable_http", {}, {}, null]]);
    const listed = await rpc<{ slug: string; hasSecret: boolean; headerKeys: string[] }[]>(
      app,
      cookie,
      "mcp/servers/list",
      {},
    );
    expect(listed.map((row) => [row.slug, row.hasSecret, row.headerKeys])).toEqual([
      ["docs", false, []],
    ]);
    // Not given to the bot, and not probed or launched: an approval card asks the user first.
    expect(servers[0]!.assignments).toEqual([]);
    expect([servers[0]!.healthStatus, servers[0]!.healthCheckedAt]).toEqual(["unknown", null]);
    // An imported bot starts inert: no intro run.
    expect(await db.run.count({ where: { botId: bot.id } })).toBe(0);
    const cards = await db.message.findMany({
      where: { thread: { botId: bot.id } },
      select: { blocks: true },
    });
    expect(
      cards.flatMap((row) => row.blocks as { kind: string; serverId?: string }[]),
    ).toContainEqual(
      expect.objectContaining({
        kind: "mcp_approval",
        serverId: servers[0]!.id,
        status: "pending",
      }),
    );
    // One checklist of what is left, written with the import: the server's credentials and
    // each paused routine, with the ids the chat opens them by.
    const routineRows = await db.routine.findMany({
      where: { botId: bot.id },
      orderBy: { createdAt: "asc" },
    });
    const checklists = cards
      .flatMap((row) => row.blocks as { kind: string; items?: unknown[] }[])
      .filter((block) => block.kind === "import_setup");
    expect(checklists).toEqual([
      {
        kind: "import_setup",
        items: [
          {
            kind: "mcp",
            serverId: servers[0]!.id,
            name: "docs",
            needs: [{ kind: "credentials", names: ["Authorization"] }],
          },
          ...routineRows.map((row) => ({ kind: "routine", routineId: row.id, name: row.name })),
        ],
      },
    ]);
    const state = () =>
      rpc<{
        providers: Record<string, boolean>;
        serverIds: Record<string, boolean>;
        routineIds: Record<string, boolean>;
      }>(app, cookie, "bots/importSetupState", {
        botId: bot.id,
        providers: ["openrouter", "deepseek"],
        serverIds: [servers[0]!.id, "missing"],
        routineIds: routineRows.map((row) => row.id),
      });
    // Read from current data: nothing approved or turned on yet; the imported key is connected.
    expect(await state()).toEqual({
      providers: { openrouter: true, deepseek: false },
      serverIds: { [servers[0]!.id]: false, missing: false },
      routineIds: Object.fromEntries(routineRows.map((row) => [row.id, false])),
    });
    await rpc(app, cookie, "mcp/assignments/approve", { botId: bot.id, serverId: servers[0]!.id });
    await db.routine.update({ where: { id: routineRows[0]!.id }, data: { active: true } });
    const approved = await state();
    // Approval is not setup: the server still has no value for its Authorization header.
    expect(approved.serverIds[servers[0]!.id]).toBe(false);
    expect(approved.routineIds[routineRows[0]!.id]).toBe(true);
    await rpc(app, cookie, "mcp/servers/update", {
      id: servers[0]!.id,
      config: {
        slug: "docs",
        name: "docs",
        description: "",
        transport: "streamable_http",
        endpoint: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer placeholder-entered-later" },
        enabled: true,
      },
    });
    // Approved, and every header it was shown to need has a value: done.
    expect((await state()).serverIds[servers[0]!.id]).toBe(true);
    await db.routine.update({ where: { id: routineRows[0]!.id }, data: { active: false } });
    // Another user reads nothing of these.
    const stranger = await signup(app, `import-state-other-${stamp}@rakazo.test`, "Stranger");
    expect(
      await rpc(app, stranger, "bots/importSetupState", {
        botId: bot.id,
        providers: [],
        serverIds: [servers[0]!.id],
        routineIds: routineRows.map((row) => row.id),
      }),
    ).toEqual({
      providers: {},
      serverIds: { [servers[0]!.id]: false },
      routineIds: Object.fromEntries(routineRows.map((row) => [row.id, false])),
    });
    expect(
      await db.botMcpServer.findMany({
        where: { botId: bot.id },
        select: { serverId: true, allowAllTools: true },
      }),
    ).toEqual([{ serverId: servers[0]!.id, allowAllTools: true }]);

    // Paused, like every new routine, whatever the source said.
    const routines = await db.routine.findMany({
      where: { botId: bot.id },
      orderBy: { name: "asc" },
    });
    expect(
      routines.map((row) => [row.name, row.crons, row.timezone, row.active, row.nextRunAt]),
    ).toEqual([
      ["check", ["*/30 * * * *"], "Europe/Berlin", false, null],
      ["morning", ["0 9 * * *"], "Asia/Kolkata", false, null],
    ]);

    const record = await db.agentImport.findFirstOrThrow({ where: { botId: bot.id } });
    expect(record).toMatchObject({ ...owner, source: "openclaw" });
    expect(record.created).toMatchObject({ mcpServers: [{ id: servers[0]!.id }] });

    // Imported again, without the opt-in: the existing slug is kept and a free one chosen.
    const again = await rpc<AgentImportPlan>(app, cookie, "bots/importPreview", {
      files: settingsHome,
    });
    expect(again.mcpServers.map((item) => [item.title, item.name])).toEqual([
      ["docs", "docs-2"],
      // Never created here (stdio is off), so its name is still free.
      ["files", "files"],
    ]);
    await rpc<Bot>(app, cookie, "bots/importCreate", {
      files: settingsHome,
      name: "Settings again",
      selection: { instructions: [], memory: [], skills: [], mcpServers: ["mcp:docs"] },
    });
    const plain = await db.mcpServer.findFirstOrThrow({ where: { ...owner, slug: "docs-2" } });
    expect([plain.headers, plain.secretId]).toEqual([{}, null]);

    // Another user sees none of it.
    const other = await signup(app, `import-settings-other-${stamp}@rakazo.test`, "Other");
    expect(await rpc<unknown[]>(app, other, "mcp/servers/list", {})).toEqual([]);
    expect(await rpc<unknown[]>(app, other, "models/credentials", {})).toEqual([]);
    expect((await raw(app, other, "routines/list", { botId: bot.id })).status).not.toBe(200);
  });

  it("writes nothing at all when the last write of the import fails", async () => {
    const cookie = await signup(app, `import-rollback-${stamp}@rakazo.test`, "Rollback User");
    const firstBot = await rpc<Bot>(app, cookie, "bots/create", { name: "First" });
    const owner = await db.bot.findUniqueOrThrow({
      where: { id: firstBot.id },
      select: { spaceId: true, userId: true },
    });
    const files = [
      ...settingsHome,
      { path: ".openclaw/workspace/USER.md", content: "Prefers tea.\n" },
      { path: ".openclaw/skills/notes/SKILL.md", content: skill("notes", "Take notes") },
    ];
    const plan = await rpc<AgentImportPlan>(app, cookie, "bots/importPreview", {
      files,
      includeSecrets: true,
    });
    const count = async () => ({
      bots: await db.bot.count({ where: owner }),
      credentials: await db.userModelCredential.count({ where: { userId: owner.userId } }),
      secrets: await db.secret.count({ where: { userId: owner.userId } }),
      servers: await db.mcpServer.count({ where: owner }),
      routines: await db.routine.count({ where: owner }),
      skills: await db.agentSkill.count({ where: owner }),
      memory: await db.memoryDocument.count({ where: owner }),
      imports: await db.agentImport.count({ where: owner }),
    });
    const before = await count();
    // The import record is the last write; make it fail after keys, memory, skills,
    // servers and routines were written in the same transaction.
    const ownerDb = createDb(process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL!);
    await ownerDb.prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION agent_import_test_fail() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql`);
    await ownerDb.prisma.$executeRawUnsafe(
      `CREATE TRIGGER agent_import_test_fail BEFORE INSERT ON agent_imports
       FOR EACH ROW EXECUTE FUNCTION agent_import_test_fail()`,
    );
    try {
      const response = await raw(app, cookie, "bots/importCreate", {
        files,
        includeSecrets: true,
        name: "Fails",
        selection: {
          instructions: plan.instructions.map((item) => item.id),
          memory: plan.memory.map((item) => ({ id: item.id, destination: "space" })),
          skills: plan.skills.map((item) => item.id),
          model: true,
          mcpServers: ["mcp:docs"],
          routines: plan.routines.map((item) => item.id),
          apiKeys: plan.apiKeys.map((item) => item.id),
        },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      await ownerDb.prisma.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS agent_import_test_fail ON agent_imports",
      );
      await ownerDb.prisma.$disconnect();
    }
    expect(await count()).toEqual(before);
  });

  it("points an imported routine at its skill when the skill is renamed on a clash", async () => {
    const cookie = await signup(app, `import-rename-${stamp}@rakazo.test`, "Rename");
    await rpc(app, cookie, "agentSkills/create", { content: skill("garden", "Already here") });
    const files = [
      { path: ".openclaw/workspace/SOUL.md", content: "Calm.\n" },
      { path: ".openclaw/skills/garden/SKILL.md", content: skill("garden", "Water plants") },
      { path: ".openclaw/skills/tools/SKILL.md", content: skill("garden tools", "Sharpen") },
      {
        path: ".openclaw/cron/jobs.json",
        content: JSON.stringify({
          jobs: [
            {
              name: "morning",
              schedule: { kind: "cron", expr: "0 9 * * *" },
              payload: {
                kind: "agentTurn",
                message: "Run @garden tools and @garden, then report.",
              },
            },
          ],
        }),
      },
    ];
    const plan = await rpc<AgentImportPlan>(app, cookie, "bots/importPreview", { files });
    const bot = await rpc<Bot>(app, cookie, "bots/importCreate", {
      files,
      name: "Renamed",
      selection: {
        instructions: plan.instructions.map((item) => item.id),
        memory: [],
        skills: plan.skills.map((item) => item.id),
        mcpServers: [],
        routines: plan.routines.map((item) => item.id),
        apiKeys: [],
      },
    });
    const routine = await db.routine.findFirstOrThrow({ where: { botId: bot.id } });
    expect(routine.prompt).toBe("Run @garden tools and @garden-2, then report.");
  });

  it("refuses a key the provider rejects, in words the client chooses, writing nothing", async () => {
    const cookie = await signup(app, `import-key-rejected-${stamp}@rakazo.test`, "Rejected User");
    const files = [
      { path: ".openclaw/workspace/SOUL.md", content: "Calm.\n" },
      { path: ".openclaw/.env", content: "OPENROUTER_API_KEY=placeholder-rejected-key\n" },
    ];
    keyCheck.status = 401;
    try {
      const response = await raw(app, cookie, "bots/importCreate", {
        files,
        includeSecrets: true,
        name: "Rejected",
        selection: {
          instructions: ["instructions:SOUL.md"],
          memory: [],
          skills: [],
          apiKeys: ["key:openrouter"],
        },
      });
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain('"reason":"key_rejected"');
      expect(body).toContain('"provider":"OpenRouter"');
      // The provider's own text never reaches the client.
      expect(body).not.toContain("rejected by the provider");
      expect(body).not.toContain("placeholder-");
    } finally {
      keyCheck.status = undefined;
    }
    const me = await rpc<Bot[]>(app, cookie, "bots/list", {});
    expect(me).toEqual([]);
  });

  it("never replaces a key connected after the import checked it", async () => {
    const cookie = await signup(app, `import-key-race-${stamp}@rakazo.test`, "Key Race User");
    const files = [
      { path: ".openclaw/workspace/SOUL.md", content: "Calm.\n" },
      { path: ".openclaw/.env", content: "OPENROUTER_API_KEY=placeholder-imported-key\n" },
    ];
    const plan = await rpc<AgentImportPlan>(app, cookie, "bots/importPreview", {
      files,
      includeSecrets: true,
    });
    expect(plan.apiKeys.map((item) => item.provider)).toEqual(["openrouter"]);
    // The user connects OpenRouter by hand while the import is checking its key.
    keyCheck.during = async () => {
      keyCheck.during = null;
      await rpc(app, cookie, "models/connect", {
        provider: "openrouter",
        apiKey: "placeholder-manual-key",
      });
    };
    const bot = await rpc<Bot>(app, cookie, "bots/importCreate", {
      files,
      includeSecrets: true,
      name: "Imported",
      selection: {
        instructions: ["instructions:SOUL.md"],
        memory: [],
        skills: [],
        apiKeys: ["key:openrouter"],
      },
    });
    const owner = await db.bot.findUniqueOrThrow({
      where: { id: bot.id },
      select: { spaceId: true, userId: true },
    });
    const credentials = await db.userModelCredential.findMany({ where: { userId: owner.userId } });
    expect(credentials).toHaveLength(1);
    expect(await db.secret.count({ where: { userId: owner.userId, kind: "model" } })).toBe(1);
  });

  it("keeps a connection made between preview and Create, and still creates the bot", async () => {
    const cookie = await signup(app, `import-key-between-${stamp}@rakazo.test`, "Between User");
    const files = [
      { path: ".openclaw/workspace/SOUL.md", content: "Calm.\n" },
      { path: ".openclaw/.env", content: "OPENROUTER_API_KEY=placeholder-imported-key\n" },
    ];
    const plan = await rpc<AgentImportPlan>(app, cookie, "bots/importPreview", {
      files,
      includeSecrets: true,
    });
    expect(plan.apiKeys.map((item) => item.id)).toEqual(["key:openrouter"]);
    // Connected by hand after the preview showed the key, before Create.
    await rpc(app, cookie, "models/connect", {
      provider: "openrouter",
      apiKey: "placeholder-manual-key",
    });
    const bot = await rpc<Bot>(app, cookie, "bots/importCreate", {
      files,
      includeSecrets: true,
      name: "Between",
      selection: {
        instructions: ["instructions:SOUL.md"],
        memory: [],
        skills: [],
        apiKeys: ["key:openrouter"],
      },
    });
    const owner = await db.bot.findUniqueOrThrow({
      where: { id: bot.id },
      select: { userId: true },
    });
    const credentials = await db.userModelCredential.findMany({ where: { userId: owner.userId } });
    expect(credentials).toHaveLength(1);
    expect(await db.secret.count({ where: { userId: owner.userId, kind: "model" } })).toBe(1);
    // A repeated id is refused even when its provider is connected.
    const repeated = await raw(app, cookie, "bots/importCreate", {
      files,
      includeSecrets: true,
      name: "Repeated",
      selection: {
        instructions: ["instructions:SOUL.md"],
        memory: [],
        skills: [],
        apiKeys: ["key:openrouter", "key:openrouter"],
      },
    });
    expect(repeated.status).toBe(400);
    // An id that was never offered is still refused.
    const refused = await raw(app, cookie, "bots/importCreate", {
      files,
      includeSecrets: true,
      name: "Unknown",
      selection: {
        instructions: ["instructions:SOUL.md"],
        memory: [],
        skills: [],
        apiKeys: ["key:anthropic"],
      },
    });
    expect(refused.status).toBe(400);
  });

  it("returns the same bot for a retried create and refuses a reused key", async () => {
    const cookie = await signup(app, `import-retry-${stamp}@rakazo.test`, "Retry User");
    const files = [{ path: "workspace/SOUL.md", content: "Calm.\n" }];
    const plan = await rpc<AgentImportPlan>(app, cookie, "bots/importPreview", { files });
    const request = {
      importKey: `retry-${stamp}`,
      files,
      name: "Retry",
      selection: { instructions: plan.instructions.map((item) => item.id), memory: [], skills: [] },
    };
    const first = await rpc<Bot>(app, cookie, "bots/importCreate", request);
    const second = await rpc<Bot>(app, cookie, "bots/importCreate", request);
    expect(second.id).toBe(first.id);
    const changed = await raw(app, cookie, "bots/importCreate", { ...request, name: "Other" });
    expect(changed.status).toBe(412);

    const concurrent = { ...request, importKey: `retry-concurrent-${stamp}` };
    const results = await Promise.all([
      raw(app, cookie, "bots/importCreate", concurrent),
      raw(app, cookie, "bots/importCreate", concurrent),
    ]);
    const ids = await Promise.all(
      results.map(async (result) => (JSON.parse(await result.text()) as { json: Bot }).json.id),
    );
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(ids[0]).toBe(ids[1]);
    const owner = await db.bot.findUniqueOrThrow({
      where: { id: first.id },
      select: { spaceId: true, userId: true },
    });
    expect(await db.agentImport.count({ where: owner })).toBe(2);
  });

  it("ignores disallowed fields a client sends anyway", async () => {
    const cookie = await signup(app, `import-raw-${stamp}@rakazo.test`, "Raw User");
    const files = [
      { path: ".openclaw/workspace/SOUL.md", content: "Calm.\n" },
      {
        path: ".openclaw/openclaw.json",
        content: JSON.stringify({
          gateway: { auth: { token: "placeholder-gateway-token" } },
          channels: { telegram: { botToken: "placeholder-channel-token" } },
          mcp: {
            servers: {
              docs: {
                url: "https://mcp.example.com/mcp",
                headers: { Authorization: "Bearer placeholder-mcp-header" },
              },
              leaky: { url: "https://mcp.example.com/mcp?token=placeholder-query-token" },
            },
          },
        }),
      },
      {
        path: ".openclaw/.env",
        content: "OPENROUTER_API_KEY=placeholder-openrouter-key\nSOME_SECRET=placeholder-unknown\n",
      },
    ];
    for (const includeSecrets of [false, true]) {
      const plan = await rpc<AgentImportPlan>(app, cookie, "bots/importPreview", {
        files,
        includeSecrets,
      });
      expect(JSON.stringify(plan)).not.toContain("placeholder-");
      expect(plan.mcpServers.map((item) => item.title)).toEqual(["docs"]);
      expect(plan.apiKeys.map((item) => item.provider)).toEqual(
        includeSecrets ? ["openrouter"] : [],
      );
    }
    const bot = await rpc<Bot>(app, cookie, "bots/importCreate", {
      files,
      includeSecrets: true,
      name: "Raw",
      selection: {
        instructions: [],
        memory: [],
        skills: [],
        mcpServers: ["mcp:docs"],
        apiKeys: ["key:openrouter"],
      },
    });
    const owner = await db.bot.findUniqueOrThrow({
      where: { id: bot.id },
      select: { spaceId: true, userId: true },
    });
    expect(
      (await db.userModelCredential.findMany({ where: { userId: owner.userId } })).map(
        (row) => row.provider,
      ),
    ).toEqual(["openrouter"]);
    const servers = await db.mcpServer.findMany({ where: owner });
    expect(servers.map((row) => [row.slug, row.endpoint, row.headers, row.secretId])).toEqual([
      ["docs", "https://mcp.example.com/mcp", {}, null],
    ]);
    for (const row of await db.secret.findMany({ where: { userId: owner.userId } })) {
      expect(row.ciphertext).not.toContain("placeholder-");
    }
  });

  it("counts an MCP server as set up only with non-blank values for every name it needs", async () => {
    const cookie = await signup(app, `import-blank-${stamp}@rakazo.test`, "Blank User");
    const files = [
      { path: ".openclaw/workspace/SOUL.md", content: "Calm.\n" },
      {
        path: ".openclaw/openclaw.json",
        content:
          '{ mcp: { servers: { api: { url: "https://mcp.example.com/mcp", headers: { Authorization: "x", "X-Team": "y" } } } } }',
      },
    ];
    const bot = await rpc<Bot>(app, cookie, "bots/importCreate", {
      files,
      name: "Blank",
      selection: {
        instructions: ["instructions:SOUL.md"],
        memory: [],
        skills: [],
        mcpServers: ["mcp:api"],
      },
    });
    const server = await db.mcpServer.findFirstOrThrow({
      where: {
        slug: "api",
        userId: (await db.bot.findUniqueOrThrow({ where: { id: bot.id } })).userId,
      },
    });
    await rpc(app, cookie, "mcp/assignments/approve", { botId: bot.id, serverId: server.id });
    const withHeaders = async (headers: Record<string, string>) => {
      await rpc(app, cookie, "mcp/servers/update", {
        id: server.id,
        config: {
          slug: "api",
          name: "api",
          description: "",
          transport: "streamable_http",
          endpoint: "https://mcp.example.com/mcp",
          headers,
          enabled: true,
        },
      });
      const state = await rpc<{ serverIds: Record<string, unknown> }>(
        app,
        cookie,
        "bots/importSetupState",
        { botId: bot.id, providers: [], serverIds: [server.id], routineIds: [] },
      );
      return state.serverIds[server.id];
    };
    // Stored names with blank values are not set, and every required name must be set.
    expect(await withHeaders({ Authorization: "", "X-Team": "" })).toBe(false);
    expect(await withHeaders({ Authorization: "   ", "X-Team": "\t" })).toBe(false);
    expect(await withHeaders({ Authorization: "Bearer placeholder-set", "X-Team": "" })).toBe(
      false,
    );
    expect(await withHeaders({ Authorization: "Bearer placeholder-set", "X-Team": "ops" })).toBe(
      true,
    );

    // Material that cannot be read leaves only this server not done, and none of it
    // reaches the reply or the logs.
    const secret = await db.secret.findFirstOrThrow({
      where: { id: (await db.mcpServer.findUniqueOrThrow({ where: { id: server.id } })).secretId! },
    });
    const store = new EncryptedSecretStore(resolveEncryptionKey());
    const putContext = { signal: new AbortController().signal } as never;
    // Short enough that a JSON parse error quotes it whole, so a leaked error would show it.
    const canary = "ph7f3e9";
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    try {
      for (const ciphertext of [
        (await store.put(`${canary} is not JSON`, putContext, { recordId: secret.id })).ciphertext,
        (
          await store.put(
            JSON.stringify({ headers: { Authorization: 7 }, env: { NOTE: canary } }),
            putContext,
            { recordId: secret.id },
          )
        ).ciphertext,
        `unreadable-${canary}`,
      ]) {
        await db.secret.update({ where: { id: secret.id }, data: { ciphertext } });
        const response = await raw(app, cookie, "bots/importSetupState", {
          botId: bot.id,
          providers: ["openrouter"],
          serverIds: [server.id],
          routineIds: ["missing-routine"],
        });
        const text = await response.text();
        expect(response.status).toBe(200);
        expect(text).not.toContain(canary);
        expect(JSON.parse(text).json).toEqual({
          providers: { openrouter: false },
          serverIds: { [server.id]: false },
          routineIds: { "missing-routine": false },
        });
      }
      expect(JSON.stringify(sink.events)).not.toContain(canary);
      expect(sink.events.map((event) => event.message)).toContain(
        "imported mcp server credential could not be read",
      );
    } finally {
      installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
    }

    // A record without the requirements it was shown (older data) counts as not done.
    const record = await db.agentImport.findFirstOrThrow({ where: { botId: bot.id } });
    const created = record.created as { mcpServers: Record<string, Prisma.InputJsonValue>[] };
    await db.agentImport.update({
      where: { id: record.id },
      data: {
        created: {
          ...created,
          mcpServers: created.mcpServers.map(({ id }) => ({ id })),
        },
      },
    });
    const unknown = await rpc<{ serverIds: Record<string, unknown> }>(
      app,
      cookie,
      "bots/importSetupState",
      {
        botId: bot.id,
        providers: [],
        serverIds: [server.id],
        routineIds: [],
      },
    );
    expect(unknown.serverIds[server.id]).toBe(false);
  });

  it("keeps imports apart between two members of one space", async () => {
    const owner = await signup(app, `import-shared-owner-${stamp}@rakazo.test`, "Owner");
    const shared = await rpc<{ id: string }>(app, owner, "spaces/create", { name: "Shared" });
    const { organizationId } = await db.space.findUniqueOrThrow({
      where: { id: shared.id },
      select: { organizationId: true },
    });
    const member = await signup(app, `import-shared-member-${stamp}@rakazo.test`, "Member");
    const memberActor = await rpc<{ userId: string }>(app, member, "me");
    await db.member.deleteMany({ where: { userId: memberActor.userId } });
    await db.member.create({
      data: {
        id: `import-shared-org-member-${stamp}`,
        organizationId,
        userId: memberActor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await db.spaceMember.create({
      data: {
        id: `import-shared-space-member-${stamp}`,
        spaceId: shared.id,
        organizationId,
        userId: memberActor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    const files = [
      { path: ".openclaw/workspace/SOUL.md", content: "Calm.\n" },
      { path: ".openclaw/workspace/USER.md", content: "Prefers tea.\n" },
      {
        path: ".openclaw/openclaw.json",
        content:
          '{ mcp: { servers: { docs: { url: "https://mcp.example.com/mcp", headers: { Authorization: "x" } } } } }',
      },
      { path: ".openclaw/skills/garden/SKILL.md", content: skill("garden", "Water plants") },
    ];
    const selection = (plan: AgentImportPlan) => ({
      instructions: plan.instructions.map((item) => item.id),
      memory: plan.memory.map((item) => ({ id: item.id, destination: "space" })),
      skills: plan.skills.map((item) => item.id),
      mcpServers: plan.mcpServers.map((item) => item.id),
    });
    const ownerPlan = await rpc<AgentImportPlan>(
      app,
      owner,
      "bots/importPreview",
      { files },
      shared.id,
    );
    const ownerBot = await rpc<Bot>(
      app,
      owner,
      "bots/importCreate",
      { files, name: "Owned", selection: selection(ownerPlan) },
      shared.id,
    );
    const server = await db.mcpServer.findFirstOrThrow({
      where: { slug: "docs", spaceId: shared.id },
    });

    // Both act in the shared space.
    const memberBot = await rpc<Bot>(app, member, "bots/create", { name: "Mine" }, shared.id);
    expect(
      (
        await db.bot.findMany({
          where: { id: { in: [ownerBot.id, memberBot.id] } },
          select: { spaceId: true },
        })
      ).map((row) => row.spaceId),
    ).toEqual([shared.id, shared.id]);
    // The member's names are their own: nothing of the owner's is taken.
    const memberPlan = await rpc<AgentImportPlan>(
      app,
      member,
      "bots/importPreview",
      { files },
      shared.id,
    );
    expect(memberPlan.skills.map((item) => item.name)).toEqual(["garden"]);
    expect(memberPlan.memory.find((item) => item.path === "USER.md")?.spacePath).toBe("USER.md");
    expect(memberPlan.mcpServers.map((item) => item.name)).toEqual(["docs"]);

    // The owner's import's setup state cannot be read by the member.
    expect(
      await rpc(
        app,
        member,
        "bots/importSetupState",
        { botId: ownerBot.id, providers: [], serverIds: [server.id], routineIds: [] },
        shared.id,
      ),
    ).toEqual({ providers: {}, serverIds: { [server.id]: false }, routineIds: {} });
  });

  it("keeps each import inside the actor's own space", async () => {
    const ownerCookie = await signup(app, `import-owner-${stamp}@rakazo.test`, "Owner");
    const otherCookie = await signup(app, `import-other-${stamp}@rakazo.test`, "Other");
    await rpc(app, ownerCookie, "agentSkills/create", { content: skill("watering", "Owner") });

    const otherPlan = await rpc<AgentImportPlan>(app, otherCookie, "bots/importPreview", {
      files: workspace,
    });
    expect(otherPlan.skills.map((item) => item.name)).toEqual(["watering", "weekly-review"]);

    const ownerPlan = await rpc<AgentImportPlan>(app, ownerCookie, "bots/importPreview", {
      files: workspace,
    });
    const memoryId = ownerPlan.memory.find((item) => item.path === "USER.md")!.id;
    const ownerBot = await rpc<Bot>(app, ownerCookie, "bots/importCreate", {
      files: workspace,
      name: "Owner bot",
      selection: {
        instructions: [],
        memory: [{ id: memoryId, destination: "space" }],
        skills: ownerPlan.skills.map((item) => item.id),
      },
    });

    expect((await raw(app, otherCookie, "bots/get", { botId: ownerBot.id })).status).not.toBe(200);
    const otherMemory = await rpc<MemoryDocument[]>(app, otherCookie, "memory/list", {});
    expect(otherMemory.some((doc) => doc.content === "Prefers metric units.\n")).toBe(false);
    const otherSkills = await rpc<{ name: string }[]>(app, otherCookie, "agentSkills/list", {});
    expect(otherSkills.some((item) => item.name === "watering")).toBe(false);
  });
});

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "test-password-123", name }),
  });
  expect(response.status).toBeLessThan(400);
  return sessionCookieHeader(response);
}

async function rpc<T>(
  app: App,
  cookie: string,
  proc: string,
  body: unknown = {},
  spaceId?: string,
): Promise<T> {
  const res = await raw(app, cookie, proc, body, spaceId);
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}

/** Undo as the app's dialog does it: for the import it was shown. */
async function raw(app: App, cookie: string, proc: string, body: unknown, spaceId?: string) {
  return app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
      ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
    },
    body: JSON.stringify({ json: body }),
  });
}
