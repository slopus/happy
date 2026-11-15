import type { AgentImportFile } from "@rakazo/contracts";
import { BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { parseSkillMd } from "../agent-skill.js";
import {
  AGENT_IMPORT_PROMPT,
  agentImportFolder,
  agentImportUpload,
  chooseAgentImportFiles,
  combineImportedInstructions,
  hasAgentImportSecrets,
  isAgentImportCandidate,
  mcpServerImportable,
  parseAgentImport,
  parseDotEnv,
  readAgentImportConfig,
  readAgentImportFolder,
  resolveAgentImportNames,
  stripAgentImportSecrets,
} from "./index.js";

const skill = (name: string, description: string, body = "Steps.\n") =>
  `---\nname: ${name}\ndescription: ${description}\nversion: 2\n---\n\n${body}`;

function plan(files: AgentImportFile[]) {
  const parsed = parseAgentImport(files);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

describe("OpenClaw workspace", () => {
  const workspace: AgentImportFile[] = [
    { path: "workspace/AGENTS.md", content: "Keep replies short.\n" },
    { path: "workspace/SOUL.md", content: "# Soul\n\nCalm and direct.\n" },
    {
      path: "workspace/IDENTITY.md",
      content: "- **Name:** Pebble\n- **Vibe:** calm\n- **Creature:** owl\n- **Emoji:** 🪨\n",
    },
    { path: "workspace/USER.md", content: "Prefers metric units.\n" },
    { path: "workspace/MEMORY.md", content: "Project Alpha ships in May.\n" },
    { path: "workspace/memory/2026-01-03.md", content: "Talked about the garden.\n" },
    { path: "workspace/memory/2026-01-02.md", content: "Planned the week.\n" },
    { path: "workspace/TOOLS.md", content: "Local tool notes.\n" },
    { path: "workspace/HEARTBEAT.md", content: "Check the inbox.\n" },
    { path: "workspace/skills/weekly-review/SKILL.md", content: skill("weekly-review", "Run it") },
    {
      path: "workspace/skills/home/garden/watering/SKILL.md",
      content: skill("watering", "Water the plants"),
    },
    { path: "workspace/.agents/skills/notes/SKILL.md", content: skill("notes", "Take notes") },
    { path: "workspace/skills/broken/SKILL.md", content: "No frontmatter here.\n" },
    { path: "workspace/sessions/2026-01-02.md", content: "EXAMPLE_KEY=placeholder\n" },
    { path: "workspace/credentials/notes.md", content: "EXAMPLE_KEY=placeholder\n" },
    { path: "workspace/logs/run.md", content: "EXAMPLE_KEY=placeholder\n" },
    { path: "workspace/projects/readme.md", content: "Unrelated project notes.\n" },
  ];

  it("maps bootstrap files, daily memory and nested skills into one plan", () => {
    const result = plan(workspace);
    expect(result.source).toBe("openclaw");
    expect(result.suggestedName).toBe("Pebble");
    // OpenClaw prefers Theme, then Creature, then Vibe.
    expect(result.suggestedDescription).toBe("owl");
    expect(result.instructions.map((item) => [item.title, item.role])).toEqual([
      ["SOUL.md", "persona"],
      ["AGENTS.md", "working"],
    ]);
    expect(result.memory.map((item) => [item.title, item.path])).toEqual([
      ["MEMORY.md", "MEMORY.md"],
      ["USER.md", "USER.md"],
      ["memory/2026-01-02.md", "memory/2026-01-02.md"],
      ["memory/2026-01-03.md", "memory/2026-01-03.md"],
    ]);
    expect(result.skills.map((item) => item.name)).toEqual(["notes", "watering", "weekly-review"]);
    const review = result.skills.find((item) => item.name === "weekly-review");
    expect(parseSkillMd(review!.content)).toMatchObject({
      name: "weekly-review",
      description: "Run it",
      frontmatter: { version: 2 },
    });
    expect(result.skipped).toEqual([
      { path: "HEARTBEAT.md", reason: "runtime" },
      { path: "IDENTITY.md: Emoji", reason: "runtime" },
      { path: "TOOLS.md", reason: "runtime" },
      { path: "skills/broken/SKILL.md", reason: "invalid_skill" },
    ]);
  });

  it("never reads private runtime folders, even when they are sent", () => {
    const result = plan(workspace);
    const everything = JSON.stringify(result);
    expect(everything).not.toContain("EXAMPLE_KEY");
    expect(everything).not.toContain("Unrelated project notes");
  });

  it("gives every item a stable id", () => {
    const first = plan(workspace);
    const second = plan([...workspace].reverse());
    expect(second).toEqual(first);
    const ids = [...first.instructions, ...first.memory, ...first.skills].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names the bot after a named workspace when it has no identity", () => {
    const result = plan([{ path: "workspace-research/SOUL.md", content: "Curious.\n" }]);
    expect(result.source).toBe("openclaw");
    expect(result.suggestedName).toBe("research");
  });
});

describe("Hermes home", () => {
  const home: AgentImportFile[] = [
    { path: ".hermes/SOUL.md", content: "Warm and precise.\n" },
    { path: ".hermes/HERMES.md", content: "Answer in English.\n" },
    {
      path: ".hermes/memories/MEMORY.md",
      content: "Deploys run on Fridays.\n§\n\n§\nThe staging host is slow.\nUse patience.\n",
    },
    { path: ".hermes/memories/USER.md", content: "Name is Sam.\n§\nLikes tea.\n" },
    {
      path: ".hermes/skills/devops/deploy-check/SKILL.md",
      content: skill("deploy-check", "Check a deploy"),
    },
    { path: ".hermes/sessions/session.md", content: "EXAMPLE_KEY=placeholder\n" },
    { path: ".hermes/cron/jobs.md", content: "EXAMPLE_KEY=placeholder\n" },
  ];

  it("splits entries, maps category skills and ignores private folders", () => {
    const result = plan(home);
    expect(result.source).toBe("hermes");
    expect(result.suggestedName).toBe("Hermes");
    expect(result.instructions.map((item) => item.title)).toEqual(["SOUL.md", "HERMES.md"]);
    expect(result.memory).toMatchObject([
      {
        title: "memories/MEMORY.md",
        path: "MEMORY.md",
        content: "Deploys run on Fridays.\n\nThe staging host is slow.\nUse patience.\n",
      },
      { title: "memories/USER.md", path: "USER.md", content: "Name is Sam.\n\nLikes tea.\n" },
    ]);
    expect(result.skills.map((item) => item.name)).toEqual(["deploy-check"]);
    expect(JSON.stringify(result)).not.toContain("EXAMPLE_KEY");
  });

  it("is detected from its memory folder without a root folder name", () => {
    expect(plan([{ path: "memories/USER.md", content: "Likes tea.\n" }]).source).toBe("hermes");
  });
});

describe("any other agent document", () => {
  const document = [
    "Sure! Here is everything I know.",
    "",
    "````markdown",
    "# Name",
    "Atlas",
    "",
    "# Instructions",
    "Be concise.",
    "",
    "```bash",
    "# Skills",
    "echo inside a code block",
    "```",
    "",
    "# Memory",
    "Works remotely.",
    "",
    "## About me",
    "Lives near the coast.",
    "",
    "## Projects",
    "Building a boat.",
    "",
    "# Skills",
    "## trip-planner",
    "Description: Plan a trip",
    "1. Ask for dates.",
    "",
    "## no-description",
    "",
    "````",
    "",
    "Let me know if you need anything else.",
  ].join("\n");

  it("tolerates chatter and an outer code fence around the sections", () => {
    const result = plan([{ path: "agent.md", content: document }]);
    expect(result.source).toBe("document");
    expect(result.suggestedName).toBe("Atlas");
    expect(result.instructions).toEqual([
      {
        id: "instructions:Instructions",
        title: "Instructions",
        content: "Be concise.\n\n```bash\n# Skills\necho inside a code block\n```\n",
        role: "working",
        stock: false,
        mentions: [],
      },
    ]);
    expect(result.memory.map((item) => [item.title, item.path, item.content])).toEqual([
      ["MEMORY.md", "MEMORY.md", "Works remotely.\n"],
      ["About me", "about-me.md", "# About me\n\nLives near the coast.\n"],
      ["Projects", "projects.md", "# Projects\n\nBuilding a boat.\n"],
    ]);
    expect(result.skills).toHaveLength(1);
    expect(parseSkillMd(result.skills[0]!.content)).toMatchObject({
      name: "trip-planner",
      description: "Plan a trip",
      body: "1. Ask for dates.\n",
    });
    expect(result.skipped).toEqual([{ path: "Skills/no-description", reason: "invalid_skill" }]);
  });

  it("accepts a document with only some sections and no fence", () => {
    const result = plan([{ path: "reply.md", content: "# Memory\nLikes tea.\n" }]);
    expect(result.suggestedName).toBe("");
    expect(result.instructions).toEqual([]);
    expect(result.skills).toEqual([]);
    expect(result.memory.map((item) => item.path)).toEqual(["MEMORY.md"]);
  });

  it.each([
    ["C#", "C#"],
    ["F#", "F#"],
    ["C##", "C##"],
    ["C#   ", "C#"],
    ["C# ##", "C#"],
    ["C#\t###\t", "C#"],
    ["Projects ###", "Projects"],
    ["Ticket #123", "Ticket #123"],
    ["Projects ###x", "Projects ###x"],
  ])("preserves literal hashes in memory heading %j", (heading, title) => {
    const result = plan([
      { path: "agent.md", content: `# Memory\n## ${heading}\nSynthetic notes.\n` },
    ]);
    expect(result.memory).toHaveLength(1);
    expect(result.memory[0]).toMatchObject({
      title,
      content: `# ${title}\n\nSynthetic notes.\n`,
    });
  });

  it("preserves literal trailing hashes in skill names", () => {
    const result = plan([
      {
        path: "agent.md",
        content: "# Skills\n## c#\nDescribe a task.\n1. Do the task.\n",
      },
    ]);
    expect(result.skills.map((item) => item.name)).toEqual(["c#"]);
    expect(result.skipped).toEqual([]);
  });

  it("accepts whitespace-separated closing hashes in skill headings", () => {
    const result = plan([
      {
        path: "agent.md",
        content: "# Skills\n## trip-planner ###\nPlan a trip.\n1. Ask for dates.\n",
      },
    ]);
    expect(result.skills.map((item) => item.name)).toEqual(["trip-planner"]);
    expect(result.skipped).toEqual([]);
  });

  it("asks for the same sections the parser reads", () => {
    for (const heading of ["# Name", "# Instructions", "# Memory", "# Skills"]) {
      expect(AGENT_IMPORT_PROMPT).toContain(`\n${heading}\n`);
    }
  });
});

describe("detection", () => {
  it("rejects files it does not recognise", () => {
    expect(parseAgentImport([{ path: "notes/todo.md", content: "Buy milk.\n" }])).toEqual({
      error: "No OpenClaw, Hermes or agent document found.",
    });
    expect(parseAgentImport([{ path: "reply.md", content: "Just chatting.\n" }])).toHaveProperty(
      "error",
    );
  });

  it("only offers recognised files for upload", () => {
    expect(isAgentImportCandidate("SOUL.md")).toBe(true);
    expect(isAgentImportCandidate("memory/2026-01-02.md")).toBe(true);
    expect(isAgentImportCandidate("skills/a/b/SKILL.md")).toBe(true);
    expect(isAgentImportCandidate("sessions/today.md")).toBe(false);
    expect(isAgentImportCandidate("projects/readme.md")).toBe(false);
  });
});

describe("instructions", () => {
  it("puts the persona first and the working instructions second, each under its purpose", () => {
    const soul = {
      title: "SOUL.md",
      content: "# SOUL.md - Who You Are\n\nCalm.\n",
      role: "persona",
    } as const;
    const agents = { title: "AGENTS.md", content: "Short replies.\n", role: "working" } as const;
    expect(combineImportedInstructions([soul])).toBe("Calm.");
    expect(combineImportedInstructions([agents])).toBe("Short replies.");
    expect(combineImportedInstructions([agents, soul])).toBe(
      "# Persona\n\nCalm.\n\n# Working instructions\n\nShort replies.",
    );
    // Hermes can have several working files; they share one section.
    expect(
      combineImportedInstructions([
        soul,
        agents,
        { title: "HERMES.md", content: "Answer in English.\n", role: "working" },
      ]),
    ).toBe("# Persona\n\nCalm.\n\n# Working instructions\n\nShort replies.\n\nAnswer in English.");
  });

  it("reports the combined length so an oversized import can be refused", () => {
    const big = "x".repeat(BOT_INSTRUCTIONS_MAX_LENGTH);
    const result = plan([
      { path: "workspace/SOUL.md", content: big },
      { path: "workspace/AGENTS.md", content: "More.\n" },
    ]);
    expect(combineImportedInstructions(result.instructions).length).toBeGreaterThan(
      BOT_INSTRUCTIONS_MAX_LENGTH,
    );
  });
});

describe("name collisions", () => {
  it("picks free names for space memory and skills instead of overwriting", () => {
    const result = plan([
      { path: "workspace/MEMORY.md", content: "Facts.\n" },
      { path: "workspace/memory/2026-01-02.md", content: "Day.\n" },
      { path: "workspace/skills/a/SKILL.md", content: skill("Notes", "First") },
      { path: "workspace/skills/b/SKILL.md", content: skill("notes", "Second") },
    ]);
    expect(result.skills.map((item) => item.name)).toEqual(["Notes", "notes-2"]);
    const resolved = resolveAgentImportNames(result, {
      spaceMemoryPaths: ["MEMORY.md", "MEMORY-2.md", "memory/2026-01-02.md"],
      skillNames: ["NOTES"],
    });
    expect(resolved.memory.map((item) => [item.path, item.spacePath])).toEqual([
      ["MEMORY.md", "MEMORY-3.md"],
      ["memory/2026-01-02.md", "memory/2026-01-02-2.md"],
    ]);
    expect(resolved.skills.map((item) => [item.title, item.name])).toEqual([
      ["Notes", "Notes-2"],
      ["notes", "notes-3"],
    ]);
    expect(parseSkillMd(resolved.skills[1]!.content)).toMatchObject({
      name: "notes-3",
      description: "Second",
    });
  });
});

describe("skill files", () => {
  const openclawSkill = [
    "---",
    "name: weather",
    "description: Get current weather and forecasts.",
    "homepage: https://example.test/weather",
    'metadata: {"openclaw":{"emoji":"🌤️","requires":{"bins":["curl"]}}}',
    "---",
    "",
    "# Weather",
    "",
    "Run `curl` against the forecast service.",
    "",
  ].join("\n");
  const hermesSkill = [
    "---",
    "name: arxiv",
    "description: Search and summarise papers.",
    "version: 1.0.0",
    "metadata:",
    "  hermes:",
    "    tags: [research, papers]",
    "required_environment_variables:",
    "  - name: EXAMPLE_KEY",
    "    prompt: Example key",
    "---",
    "",
    "## Steps",
    "1. Search.",
    "",
  ].join("\n");

  it("keeps SKILL.md exactly as written", () => {
    const openclaw = plan([
      { path: "workspace/SOUL.md", content: "Calm.\n" },
      { path: "workspace/skills/weather/SKILL.md", content: openclawSkill },
    ]);
    expect(openclaw.skills.map((item) => item.content)).toEqual([openclawSkill]);
    const hermes = plan([
      { path: ".hermes/SOUL.md", content: "Calm.\n" },
      { path: ".hermes/skills/research/arxiv/SKILL.md", content: hermesSkill },
    ]);
    expect(hermes.skills.map((item) => item.content)).toEqual([hermesSkill]);
  });

  it("keeps a byte order mark and CRLF line endings, byte for byte", () => {
    const original = `\uFEFF${hermesSkill.replaceAll("\n", "\r\n")}`;
    const result = plan([{ path: "workspace/skills/arxiv/SKILL.md", content: original }]);
    expect(result.skills[0]!.content).toBe(original);
    const renamed = resolveAgentImportNames(result, {
      spaceMemoryPaths: [],
      skillNames: ["arxiv"],
    });
    expect(renamed.skills[0]!.content).toBe(
      original.replace("name: arxiv\r\n", "name: arxiv-2\r\n"),
    );
  });

  it("renames by rewriting only the name line", () => {
    const result = plan([
      { path: "workspace/skills/weather/SKILL.md", content: openclawSkill },
      { path: "workspace/skills/arxiv/SKILL.md", content: hermesSkill },
    ]);
    const renamed = resolveAgentImportNames(result, {
      spaceMemoryPaths: [],
      skillNames: ["Weather", "arxiv", "arxiv-2"],
    });
    expect(renamed.skills.map((item) => [item.name, item.content])).toEqual([
      ["arxiv-3", hermesSkill.replace("name: arxiv\n", "name: arxiv-3\n")],
      ["weather-2", openclawSkill.replace("name: weather\n", "name: weather-2\n")],
    ]);
    const restored = resolveAgentImportNames(renamed, { spaceMemoryPaths: [], skillNames: [] });
    expect(restored.skills.map((item) => item.content)).toEqual([hermesSkill, openclawSkill]);
  });
});

describe("OpenClaw home folder", () => {
  const home = [
    ".openclaw/openclaw.json",
    ".openclaw/.env",
    ".openclaw/credentials/notes.md",
    ".openclaw/agents/main/sessions/today.md",
    ".openclaw/workspace/SOUL.md",
    ".openclaw/workspace/memory/2026-01-02.md",
    ".openclaw/workspace/skills/shared/SKILL.md",
    ".openclaw/workspace-research/SOUL.md",
    ".openclaw/skills/shared/SKILL.md",
    ".openclaw/skills/managed/SKILL.md",
  ];

  it("uses the main workspace plus managed skills and nothing else", () => {
    const folder = agentImportFolder(home);
    expect(folder.root).toBe("workspace");
    expect([...folder.files]).toEqual([
      [".openclaw/workspace/SOUL.md", "SOUL.md"],
      [".openclaw/workspace/memory/2026-01-02.md", "memory/2026-01-02.md"],
      [".openclaw/workspace/skills/shared/SKILL.md", "skills/shared/SKILL.md"],
      [".openclaw/openclaw.json", "openclaw.json"],
      [".openclaw/.env", ".env"],
      [".openclaw/skills/managed/SKILL.md", "skills/managed/SKILL.md"],
    ]);
  });

  it("uses the only named workspace, and none when there are several", () => {
    const named = agentImportFolder([
      ".openclaw/workspace-research/SOUL.md",
      ".openclaw/openclaw.json",
    ]);
    expect(named.root).toBe("workspace-research");
    expect([...named.files.values()]).toEqual(["SOUL.md", "openclaw.json"]);
    const several = [".openclaw/workspace-a/SOUL.md", ".openclaw/workspace-b/SOUL.md"];
    expect(agentImportFolder(several).files.size).toBe(0);
    expect(parseAgentImport(several.map((path) => ({ path, content: "Calm.\n" })))).toEqual({
      error: "No OpenClaw, Hermes or agent document found.",
    });
  });

  it("parses the files the folder choice keeps", () => {
    const files = home
      .filter((path) => path.endsWith(".md"))
      .map((path) => ({
        path,
        content: path.endsWith("SKILL.md")
          ? skill(path.split("/").at(-2)!, "Use it")
          : `From ${path}\n`,
      }));
    const result = plan(files);
    expect(result.source).toBe("openclaw");
    expect(result.instructions.map((item) => item.content)).toEqual([
      "From .openclaw/workspace/SOUL.md\n",
    ]);
    expect(result.memory.map((item) => item.path)).toEqual(["memory/2026-01-02.md"]);
    expect(result.skills.map((item) => item.name)).toEqual(["managed", "shared"]);
    expect(JSON.stringify(result)).not.toContain("credentials");
    expect(JSON.stringify(result)).not.toContain("workspace-research");
  });
});

describe("real OpenClaw home tree", () => {
  it("reads only the workspace, managed skills and settings files", () => {
    const tree = [
      "openclaw.json",
      "openclaw.json.last-good",
      "openclaw.json.bak",
      "openclaw.json.bak.1",
      "config-journal-fingerprint.key",
      ".env",
      "cron/jobs.json",
      "agents/main/agent/AGENTS.md",
      "agents/main/sessions/today.md",
      "state/openclaw.sqlite",
      "migration/report.md",
      "media/outbound/note.md",
      "plugin-skills/canvas/SKILL.md",
      "cache/control-ui-assets/index.md",
      "tmp/agent-cli/notes.md",
      "credentials/notes.md",
      "workspace/.git/description",
      "workspace/.git/HEAD",
      "workspace/SOUL.md",
      "workspace/BOOTSTRAP.md",
      "workspace/IDENTITY.md",
      "workspace/memory/2026-10-20.md",
      "workspace/skills/garden/SKILL.md",
    ].map((path) => `.openclaw/${path}`);
    expect([...agentImportFolder(tree).files.values()]).toEqual([
      "SOUL.md",
      "BOOTSTRAP.md",
      "IDENTITY.md",
      "memory/2026-10-20.md",
      "skills/garden/SKILL.md",
      "openclaw.json",
      ".env",
      "cron/jobs.json",
    ]);
  });

  it("does not take the untouched identity template's hint as the name", () => {
    const template = [
      "# IDENTITY.md - Who Am I?",
      "",
      "- **Name:**",
      "  _(pick something you like)_",
      "- **Creature:**",
      "  _(AI? robot? familiar? ghost in the machine? something weirder?)_",
    ].join("\n");
    const soul = { path: "workspace/SOUL.md", content: "Calm.\n" };
    const blank = plan([soul, { path: "workspace/IDENTITY.md", content: template }]);
    expect([blank.suggestedName, blank.suggestedDescription]).toEqual(["OpenClaw", ""]);
    expect(
      plan([
        soul,
        { path: "workspace/IDENTITY.md", content: "- **Name:** _(pick something you like)_" },
      ]).suggestedName,
    ).toBe("OpenClaw");
  });
});

describe("Hermes bundled skills", () => {
  it("skips the skills Hermes installed itself", () => {
    const result = plan([
      { path: ".hermes/SOUL.md", content: "Direct.\n" },
      { path: ".hermes/skills/.bundled_manifest", content: "arxiv:abc123\ngithub:def456\n" },
      { path: ".hermes/skills/research/arxiv/SKILL.md", content: skill("arxiv", "Papers") },
      {
        path: ".hermes/skills/software-development/github/SKILL.md",
        content: skill("github", "PRs"),
      },
      { path: ".hermes/skills/mine/garden-log/SKILL.md", content: skill("garden-log", "Mine") },
    ]);
    expect(result.skills.map((item) => item.name)).toEqual(["garden-log"]);
    expect(result.skipped).toEqual([]);
  });

  it("never reads or sends a bundled skill's file", async () => {
    const files: Record<string, string> = {
      ".hermes/SOUL.md": "Direct.\n",
      ".hermes/skills/.bundled_manifest": "arxiv:abc123\ngithub:def456\n",
      ".hermes/skills/research/arxiv/SKILL.md": skill("arxiv", "Papers"),
      ".hermes/skills/software-development/github/SKILL.md": skill("github", "PRs"),
      ".hermes/skills/mine/garden-log/SKILL.md": skill("garden-log", "Mine"),
    };
    const read: string[] = [];
    const chosen = await chooseAgentImportFiles(
      Object.keys(files),
      (path) => {
        read.push(path);
        return files[path]!;
      },
      { includeSecrets: false },
    );
    expect(chosen.entries.map((entry) => entry.home)).toEqual([
      "SOUL.md",
      "skills/.bundled_manifest",
      "skills/mine/garden-log/SKILL.md",
    ]);
    expect(read.filter((path) => path.includes("arxiv") || path.includes("github"))).toEqual([]);
  });
});

describe("secret stripping", () => {
  const openclawJson = `{
    // JSON5, as OpenClaw allows
    agents: {
      defaults: { model: { primary: "openrouter/anthropic/claude-sonnet-4.6" } },
      entries: { main: { workspace: "/home/example/.openclaw/workspace", model: "x-ai/grok-4" } },
    },
    gateway: { auth: { token: "placeholder-gateway-token" } },
    channels: { telegram: { botToken: "placeholder-channel-token" } },
    env: { vars: { OPENROUTER_API_KEY: "placeholder-env-key" } },
    models: { providers: { anthropic: { apiKey: "placeholder-provider-key", headers: { "X-Key": "placeholder-provider-header" } } } },
    plugins: { entries: { search: { config: { apiKey: "placeholder-plugin-key" } } } },
    mcp: {
      servers: {
        docs: {
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer placeholder-header-token" },
          oauth: { clientSecret: "placeholder-client-secret" },
        },
        files: { command: "npx", args: ["-y", "server"], env: { EXAMPLE_TOKEN: "placeholder-env-token" } },
      },
    },
  }`;
  const hermesYaml = [
    "model:",
    "  default: anthropic/claude-sonnet-4.6",
    "  provider: openrouter",
    "  api_key: placeholder-model-key",
    "providers:",
    "  gemini:",
    "    api_key: placeholder-gemini-key",
    "    extra_headers: { X-Key: placeholder-extra-header }",
    "custom_providers:",
    "  - name: local",
    "    api_key: placeholder-custom-key",
    "mcp_servers:",
    "  docs:",
    "    url: https://mcp.example.com/mcp",
    "    headers:",
    "      Authorization: Bearer placeholder-header-token",
  ].join("\n");

  it("keeps what an import reads and no secret value", () => {
    const openclaw = stripAgentImportSecrets("openclaw.json", openclawJson);
    expect(openclaw).not.toMatch(/placeholder/);
    expect(readAgentImportConfig("openclaw.json", openclaw)).toEqual({
      agents: {
        defaults: { model: { primary: "openrouter/anthropic/claude-sonnet-4.6" } },
        entries: { main: { model: "x-ai/grok-4", workspace: "workspace" } },
        list: [],
      },
      mcp: {
        servers: {
          docs: {
            url: "https://mcp.example.com/mcp",
            auth: true,
            headers: { Authorization: "" },
            env: {},
          },
          files: {
            command: "npx",
            args: ["-y", "server"],
            headers: {},
            env: { EXAMPLE_TOKEN: "" },
          },
        },
      },
    });
    const hermes = stripAgentImportSecrets("config.yaml", hermesYaml);
    expect(hermes).not.toMatch(/placeholder/);
    expect(readAgentImportConfig("config.yaml", hermes)).toEqual({
      model: { default: "anthropic/claude-sonnet-4.6", provider: "openrouter" },
      mcp_servers: {
        docs: { url: "https://mcp.example.com/mcp", headers: { Authorization: "" }, env: {} },
      },
    });
  });

  it("drops secret files and unreadable settings, and leaves other files alone", () => {
    expect(stripAgentImportSecrets(".env", "OPENROUTER_API_KEY=placeholder")).toBe("");
    expect(stripAgentImportSecrets("auth.json", "{}")).toBe("");
    expect(stripAgentImportSecrets("openclaw.json", "{ not json")).toBe("");
    expect(stripAgentImportSecrets("cron/jobs.json", '{"jobs":[]}')).toBe('{"jobs":[]}');
  });

  it("tells whether the opt-in would add anything", () => {
    expect(hasAgentImportSecrets("openclaw.json", openclawJson)).toBe(true);
    expect(hasAgentImportSecrets("config.yaml", hermesYaml)).toBe(true);
    expect(
      hasAgentImportSecrets(
        "openclaw.json",
        stripAgentImportSecrets("openclaw.json", openclawJson),
      ),
    ).toBe(false);
    expect(hasAgentImportSecrets(".env", "A=1")).toBe(true);
    expect(hasAgentImportSecrets("cron/jobs.json", "{}")).toBe(false);
  });

  it("is applied on the server too unless the user opted in", () => {
    const files = [
      { path: ".openclaw/workspace/SOUL.md", content: "Calm.\n" },
      { path: ".openclaw/openclaw.json", content: openclawJson },
      { path: ".openclaw/.env", content: "OPENROUTER_API_KEY=placeholder-env-key" },
    ];
    const without = readAgentImportFolder(files, { includeSecrets: false })!;
    expect([...without.files.keys()]).toEqual(["SOUL.md", "openclaw.json"]);
    expect(JSON.stringify([...without.files])).not.toMatch(/placeholder/);
    const opted = readAgentImportFolder(files, { includeSecrets: true })!;
    expect(opted.files.get(".env")).toBe("OPENROUTER_API_KEY=placeholder-env-key\n");
    expect(opted.files.get("openclaw.json")).not.toContain("placeholder-gateway-token");
  });

  it("with the opt-in, keeps each key's base URL so the server can judge it", () => {
    const upload = agentImportUpload(
      [
        {
          path: ".openclaw/openclaw.json",
          home: "openclaw.json",
          content: JSON.stringify({
            models: {
              providers: {
                openai: { baseUrl: "https://gateway.example.com/v1", apiKey: "placeholder-gw" },
                deepseek: { baseUrl: "https://gateway.example.com/v1" },
              },
            },
          }),
        },
        {
          path: ".openclaw/.env",
          home: ".env",
          content:
            "GROQ_API_KEY=placeholder-groq\nGROQ_BASE_URL=https://gateway.example.com\nOTHER_URL=x",
        },
      ],
      { includeSecrets: true },
    );
    const files = Object.fromEntries(upload.map((file) => [file.path, file.content]));
    expect(readAgentImportConfig("openclaw.json", files[".openclaw/openclaw.json"]!)).toMatchObject(
      {
        models: {
          providers: {
            openai: { baseUrl: "https://gateway.example.com/v1", apiKey: "placeholder-gw" },
            deepseek: { baseUrl: "https://gateway.example.com/v1" },
          },
        },
      },
    );
    expect(files[".openclaw/.env"]).toBe(
      "GROQ_API_KEY=placeholder-groq\nGROQ_BASE_URL=https://gateway.example.com\n",
    );
  });

  it("with the opt-in, sends only model-provider keys", () => {
    const env = [
      "# Hermes environment (shaped like the real file)",
      ...Array.from({ length: 30 }, (_, index) => `# EXAMPLE_SETTING_${index}=`),
      "# OPENROUTER_API_KEY=",
      "",
      "TERMINAL_TIMEOUT=60",
      "TELEGRAM_BOT_TOKEN=placeholder-telegram-token",
      "DOCS_TOKEN=placeholder-docs-token",
      'ANTHROPIC_API_KEY="placeholder-anthropic-key"',
      "OPENROUTER_API_KEY=placeholder-openrouter-key",
    ].join("\n");
    const upload = agentImportUpload(
      [
        { path: ".openclaw/openclaw.json", home: "openclaw.json", content: openclawJson },
        { path: ".openclaw/.env", home: ".env", content: env },
        {
          path: ".openclaw/auth.json",
          home: "auth.json",
          content: JSON.stringify({
            credential_pool: {
              openai: [{ auth_type: "oauth", source: "device", access_token: "placeholder-oauth" }],
              deepseek: [
                { auth_type: "api_key", source: "manual", access_token: "placeholder-pool-key" },
              ],
            },
          }),
        },
      ],
      { includeSecrets: true },
    );
    const body = JSON.stringify(upload);
    for (const secret of [
      "placeholder-gateway-token",
      "placeholder-channel-token",
      "placeholder-telegram-token",
      "placeholder-plugin-key",
      "placeholder-oauth",
      "TERMINAL_TIMEOUT",
      "EXAMPLE_SETTING",
    ]) {
      expect(body).not.toContain(secret);
    }
    const sent = new Map(upload.map((file) => [file.path, file.content]));
    expect(parseDotEnv(sent.get(".openclaw/.env")!)).toEqual({
      ANTHROPIC_API_KEY: "placeholder-anthropic-key",
      OPENROUTER_API_KEY: "placeholder-openrouter-key",
    });
    const config = readAgentImportConfig("openclaw.json", sent.get(".openclaw/openclaw.json")!)!;
    expect(config.env).toEqual({ vars: { OPENROUTER_API_KEY: "placeholder-env-key" } });
    expect(config.models).toEqual({
      providers: { anthropic: { apiKey: "placeholder-provider-key" } },
    });
    expect(JSON.stringify(config.mcp)).not.toContain("placeholder-header-token");
    expect(sent.get(".openclaw/auth.json")).toContain("placeholder-pool-key");
  });

  it("never sends MCP credential values, or .env names only they refer to", () => {
    const config =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: OpenClaw's own ${VAR} reference syntax.
      '{ mcp: { servers: { docs: { url: "https://mcp.example.test", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } } } } }';
    const upload = agentImportUpload(
      [
        { path: "h/openclaw.json", home: "openclaw.json", content: config },
        {
          path: "h/.env",
          home: ".env",
          content: "DOCS_TOKEN=placeholder-docs\nOTHER=placeholder-other\n",
        },
      ],
      { includeSecrets: true },
    );
    expect(JSON.stringify(upload)).not.toContain("placeholder-");
    expect(JSON.stringify(upload)).not.toContain("DOCS_TOKEN");
  });
});

describe("skill compatibility", () => {
  const files = (content: string) => [
    { path: "workspace/SOUL.md", content: "Calm.\n" },
    { path: "workspace/skills/a/SKILL.md", content },
  ];
  const warnings = (content: string, siblings: string[] = []) =>
    plan2(files(content), { "skills/a/SKILL.md": siblings }).skills[0]!.warnings;
  const plan2 = (input: AgentImportFile[], skillFiles: Record<string, string[]>) => {
    const parsed = parseAgentImport(input, skillFiles);
    if ("error" in parsed) throw new Error(parsed.error);
    return parsed;
  };

  it("flags declared requirements from OpenClaw and Hermes skills", () => {
    const openclaw = `---\nname: a\ndescription: d\nmetadata: {"openclaw":{"requires":{"bins":["gh"]}}}\n---\n\nUse gh.\n`;
    const macOnly = `---\nname: a\ndescription: d\nmetadata: {"openclaw":{"os":["darwin"]}}\n---\n\nNotes.\n`;
    const hermes = [
      "---",
      "name: a",
      "description: d",
      "platforms: [macos]",
      "required_environment_variables:",
      "  - name: EXAMPLE_KEY",
      "---",
      "",
      "Notes.",
    ].join("\n");
    const toolsets =
      "---\nname: a\ndescription: d\nmetadata:\n  hermes:\n    requires_toolsets: [browser]\n---\n\nNotes.\n";
    const plain = "---\nname: a\ndescription: d\n---\n\nJust notes.\n";
    expect(warnings(openclaw)).toEqual(["needs_setup"]);
    expect(warnings(macOnly)).toEqual(["needs_setup"]);
    expect(warnings(hermes)).toEqual(["needs_setup"]);
    expect(warnings(toolsets)).toEqual(["needs_setup"]);
    expect(warnings(plain)).toEqual([]);
  });

  it("flags runnable code and files the skill expects next to it", () => {
    const code = "---\nname: a\ndescription: d\n---\n\n```bash\nrm -rf build\n```\n";
    const shebang = "---\nname: a\ndescription: d\n---\n\n#!/usr/bin/env python3\nprint(1)\n";
    const prose = "---\nname: a\ndescription: d\n---\n\n```text\nhello\n```\n";
    const bundled = "---\nname: a\ndescription: d\n---\n\nFollow {baseDir}/references/guide.md\n";
    const script = "---\nname: a\ndescription: d\n---\n\nRun scripts/build.sh\n";
    expect(warnings(code)).toEqual(["runs_code"]);
    expect(warnings(shebang)).toEqual(["runs_code"]);
    expect(warnings(prose)).toEqual([]);
    expect(warnings(bundled, ["references/guide.md"])).toEqual(["bundled_files"]);
    // The reference alone is enough: the files are not imported either way.
    expect(warnings(bundled)).toEqual(["bundled_files"]);
    expect(warnings(script, ["scripts/build.sh"])).toEqual(["bundled_files", "runs_code"]);
  });
});

describe("which MCP servers an import keeps", () => {
  const config = `{
    mcp: {
      servers: {
        query: { url: "https://mcp.example.test/mcp?token=placeholder-query-token" },
        unnamed: { url: "https://mcp.example.test/mcp?access_token_value=placeholder-query-value" },
        fragment: { url: "https://mcp.example.test/mcp#placeholder-fragment" },
        userinfo: { url: "https://user:placeholder-password@mcp.example.test/mcp" },
        flag: { command: "npx", args: ["-y", "server", "--api-key=placeholder-flag-key"] },
        split: { command: "npx", args: ["server", "--token", "placeholder-split-token"] },
        header: { command: "npx", args: ["server", "--header", "Authorization: Bearer placeholder-header-arg"] },
        argurl: { command: "npx", args: ["server", "https://user:placeholder-arg-password@mcp.example.test/mcp"] },
        assignment: { command: "env", args: ["EXAMPLE_API_KEY=placeholder-env-arg", "server"] },
        program: { command: "/usr/local/bin/placeholder-program", args: [] },
        remote: { url: "https://mcp.example.test/mcp", headers: { Authorization: "Bearer placeholder-header" } },
        local: { command: "npx", args: ["-y", "@scope/server@1.2.3", "./data"], env: { TOKEN: "placeholder-env" } },
      },
    },
  }`;
  const kept = ["remote", "local"];

  it("keeps only plain URLs and plain commands", () => {
    const parsed = readAgentImportConfig("openclaw.json", config)!;
    const servers = (parsed.mcp as { servers: Record<string, Record<string, unknown>> }).servers;
    expect(
      Object.entries(servers).flatMap(([name, entry]) =>
        mcpServerImportable(entry) ? [name] : [],
      ),
    ).toEqual(kept);
  });

  it("sends only the names of the others, with or without the opt-in", () => {
    for (const includeSecrets of [false, true]) {
      const upload = agentImportUpload(
        [{ path: "h/openclaw.json", home: "openclaw.json", content: config }],
        { includeSecrets },
      );
      const body = JSON.stringify(upload);
      expect(body).not.toMatch(/placeholder-/);
      expect(body).not.toContain("Bearer");
      expect(body).toContain("@scope/server@1.2.3");
      const sent = readAgentImportConfig("openclaw.json", upload[0]!.content)!;
      const servers = (sent.mcp as { servers: Record<string, Record<string, unknown>> }).servers;
      expect(Object.keys(servers)).toHaveLength(12);
      expect(
        Object.entries(servers).flatMap(([name, entry]) => (entry.skipped ? [] : [name])),
      ).toEqual(kept);
    }
  });

  it("copies only named primitive fields, never source objects", () => {
    const sentinel = "placeholder-sentinel";
    const source = JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "openrouter/example", apiKey: sentinel, extra: { sentinel } },
        },
        list: [
          {
            id: "main",
            model: { primary: "openrouter/example", nested: sentinel },
            note: sentinel,
          },
        ],
      },
      models: {
        providers: {
          openrouter: { apiKey: { source: "env", id: "OPENROUTER_API_KEY", extra: sentinel } },
          deepseek: { apiKey: { source: "file", path: sentinel } },
        },
      },
      env: { vars: { OPENROUTER_API_KEY: { nested: sentinel } } },
      mcp: {
        servers: {
          remote: {
            url: "https://mcp.example.test/mcp",
            toolFilter: { include: ["read"], extra: sentinel },
            enabled: { sentinel },
            metadata: { sentinel },
          },
        },
      },
    });
    for (const includeSecrets of [false, true]) {
      const upload = agentImportUpload(
        [{ path: "h/openclaw.json", home: "openclaw.json", content: source }],
        { includeSecrets },
      );
      expect(JSON.stringify(upload)).not.toContain(sentinel);
    }
    const yaml = [
      "model:",
      "  provider: openrouter",
      "  default: { nested: placeholder-sentinel }",
      "  api_key: { source: file, path: placeholder-sentinel }",
      "providers:",
      "  openrouter: { api_key: { source: env, id: OPENROUTER_API_KEY, extra: placeholder-sentinel } }",
    ].join("\n");
    const upload = agentImportUpload(
      [{ path: "h/config.yaml", home: "config.yaml", content: yaml }],
      {
        includeSecrets: true,
      },
    );
    expect(JSON.stringify(upload)).not.toContain(sentinel);
    expect(JSON.stringify(upload)).toContain("OPENROUTER_API_KEY");
  });
});

describe("dotenv parsing", () => {
  it.each([
    ['"placeholder-key" # comment', "placeholder-key"],
    ["'placeholder-key' # comment", "placeholder-key"],
    ['"placeholder-key" # "quoted comment"', "placeholder-key"],
    ["'placeholder-key' # 'quoted comment'", "placeholder-key"],
    [String.raw`'placeholder\' # comment'`, "placeholder\\"],
    ['"placeholder-key"# comment', "placeholder-key"],
    ['"placeholder # key" # comment', "placeholder # key"],
    ["'placeholder # key' # comment", "placeholder # key"],
    ['"" # comment', ""],
    ["'' # comment", ""],
    ['"placeholder-key"', "placeholder-key"],
    ["'placeholder-key'", "placeholder-key"],
    ["placeholder-key # comment", "placeholder-key"],
    ["placeholder#key", "placeholder#key"],
  ])("reads OPENAI_API_KEY=%s", (value, expected) => {
    expect(parseDotEnv(`OPENAI_API_KEY=${value}`)).toEqual({ OPENAI_API_KEY: expected });
  });
});

describe("settings parsing", () => {
  it("refuses prototype keys, deep nesting and alias bombs", () => {
    expect(
      readAgentImportConfig("openclaw.json", '{ "__proto__": { "polluted": true } }'),
    ).toBeNull();
    expect(readAgentImportConfig("config.yaml", "constructor:\n  prototype: 1\n")).toBeNull();
    const deep = `${"{ a: ".repeat(40)}1${" }".repeat(40)}`;
    expect(readAgentImportConfig("openclaw.json", deep)).toBeNull();
    const bomb = [
      "a: &a [x, x, x, x, x, x, x, x, x, x]",
      "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]",
      "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]",
      "d: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]",
    ].join("\n");
    expect(readAgentImportConfig("config.yaml", bomb)).toBeNull();
    expect(readAgentImportConfig("config.yaml", "model:\n  provider: openrouter\n")).toEqual({
      model: { provider: "openrouter" },
    });
  });
});

describe("reading a chosen folder", () => {
  const files: Record<string, string> = {
    "h/SOUL.md": "Calm.\n",
    "h/config.yaml": "model:\n  provider: openrouter\n",
    "h/.env": "OPENROUTER_API_KEY=placeholder\n",
    "h/auth.json": "{}",
  };

  it("reads .env and auth.json only after the opt-in", async () => {
    const read: string[] = [];
    const reader = (path: string) => {
      read.push(path);
      return files[path]!;
    };
    const without = await chooseAgentImportFiles(Object.keys(files), reader, {
      includeSecrets: false,
    });
    expect(without.hasSecretFiles).toBe(true);
    expect(read.sort()).toEqual(["h/SOUL.md", "h/config.yaml"]);
    const opted = await chooseAgentImportFiles(Object.keys(files), reader, {
      includeSecrets: true,
    });
    expect(opted.entries.map((entry) => entry.home).sort()).toEqual([
      ".env",
      "SOUL.md",
      "auth.json",
      "config.yaml",
    ]);
  });

  it("refuses an oversized choice before reading anything", async () => {
    const read: string[] = [];
    const reader = (path: string) => {
      read.push(path);
      return files[path]!;
    };
    await expect(
      chooseAgentImportFiles(Object.keys(files), reader, {
        includeSecrets: false,
        size: (path) => (path === "h/SOUL.md" ? 50 * 1024 * 1024 : 10),
      }),
    ).rejects.toMatchObject({ reason: "too_large" });
    const many = Array.from({ length: 600 }, (_, index) => `h/memory/${index}.md`);
    await expect(
      chooseAgentImportFiles(["h/SOUL.md", ...many], reader, { includeSecrets: false }),
    ).rejects.toMatchObject({ reason: "too_large" });
    expect(read).toEqual([]);
  });
});
