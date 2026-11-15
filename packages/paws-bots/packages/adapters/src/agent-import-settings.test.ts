import { agentImportUpload, parseGrokBotExport, readAgentImportFolder } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  intervalCron,
  normalizeImportProvider,
  parseDotEnv,
  readAgentImportSettings,
  readGrokBotImportSettings,
} from "./agent-import-settings.js";

// Shaped like a real `~/.openclaw/openclaw.json` (JSON5: comments and trailing commas).
const openclawJson = `{
  // written by onboarding
  agents: {
    entries: {
      main: { name: "main", workspace: "/home/example/.openclaw/workspace", },
      research: { workspace: "/home/example/.openclaw/workspace-research", model: "x-ai/grok-4" },
    },
    defaults: {
      workspace: "/home/example/.openclaw/workspace",
      model: { primary: "openrouter/anthropic/claude-sonnet-4.6" },
    },
  },
  gateway: { auth: { mode: "token", token: "placeholder-gateway-token" } },
  channels: { telegram: { botToken: "placeholder-channel-token" } },
  env: { vars: { DEEPSEEK_API_KEY: "placeholder-deepseek-key" } },
  models: { providers: { anthropic: { apiKey: "\${ANTHROPIC_API_KEY}" } } },
  mcp: {
    servers: {
      docs: {
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer \${DOCS_TOKEN}" },
      },
      files: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        env: { EXAMPLE_TOKEN: { source: "env", id: "EXAMPLE_TOKEN" } },
        toolFilter: { include: ["read_file"] },
      },
      vault: { command: "vault-mcp", env: { TOKEN: { source: "file", id: "/run/token" } } },
      signin: { url: "https://mcp.example.com/oauth", auth: "oauth" },
      partial: { url: "https://mcp.example.com/p", toolFilter: { exclude: ["delete"] } },
    },
  },
}`;

const openclawEnv = [
  "# provider keys",
  "OPENROUTER_API_KEY=placeholder-openrouter-key",
  'ANTHROPIC_API_KEY="placeholder-anthropic-key"',
  "DOCS_TOKEN=placeholder-docs-token",
  "EXAMPLE_TOKEN=placeholder-env-token",
  "TELEGRAM_BOT_TOKEN=placeholder-telegram-token",
].join("\n");

// Shaped like `openclaw cron list --json`, saved as cron/jobs.json.
const openclawJobs = JSON.stringify({
  jobs: [
    {
      name: "heartbeat-main",
      declarationKey: "heartbeat:main",
      enabled: true,
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
      name: "Memory Dreaming Promotion",
      enabled: true,
      schedule: { kind: "cron", expr: "0 3 * * *" },
      payload: {
        kind: "agentTurn",
        message: "__openclaw_memory_core_short_term_promotion_dream__",
      },
    },
    {
      name: "morning",
      enabled: false,
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Kolkata" },
      payload: { kind: "agentTurn", message: "Summarise my day", toolsAllow: ["web_search"] },
    },
    {
      name: "evening",
      schedule: { kind: "cron", expr: "0 18 * * *", tz: "Mars/Olympus" },
      payload: { kind: "agentTurn", message: "Wrap up" },
    },
    {
      name: "odd",
      schedule: { kind: "every", everyMs: 7 * 60_000 },
      payload: { kind: "agentTurn", message: "Odd interval" },
    },
    {
      name: "once",
      schedule: { kind: "at", at: "2026-01-01T09:00:00Z" },
      payload: { kind: "agentTurn", message: "Once" },
    },
    {
      name: "theirs",
      agentId: "research",
      schedule: { kind: "cron", expr: "0 8 * * *" },
      payload: { kind: "agentTurn", message: "Research digest" },
    },
  ],
});

const hermesConfig = `# Hermes config (mostly comments)
model:
  default: "anthropic/claude-sonnet-4.6"
  # provider: auto
  provider: "openrouter"
  base_url: "https://openrouter.ai/api/v1"
providers:
  gemini:
    api_key: placeholder-gemini-key
mcp_servers:
  docs:
    url: https://mcp.example.com/mcp
    headers:
      Authorization: "Bearer placeholder-header-token"
  files:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    env:
      EXAMPLE_TOKEN: placeholder-env-token
    tools:
      include: [read_file, list_directory]
`;

const hermesJobs = JSON.stringify({
  jobs: [
    {
      id: "a1",
      name: "morning",
      prompt: "Summarise my day",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      enabled: true,
      script: null,
      no_agent: false,
    },
    {
      id: "b2",
      name: "check",
      prompt: "Check the inbox",
      schedule: { kind: "interval", minutes: 120 },
      enabled: true,
    },
    { id: "c3", name: "later", prompt: "Once", schedule: { kind: "once", run_at: "2026-01-01" } },
    {
      id: "d4",
      name: "backup",
      prompt: "",
      script: "backup.sh",
      schedule: { kind: "cron", expr: "0 1 * * *" },
    },
  ],
});

const hermesAuth = JSON.stringify({
  credential_pool: {
    deepseek: [{ auth_type: "api_key", source: "manual", access_token: "placeholder-pool-key" }],
    openai: [{ auth_type: "oauth", source: "device", access_token: "placeholder-oauth-token" }],
  },
});

function openclaw(includeSecrets: boolean, root = "workspace") {
  return readAgentImportSettings(
    {
      source: "openclaw",
      root,
      files: new Map([
        ["openclaw.json", openclawJson],
        [".env", openclawEnv],
        ["cron/jobs.json", openclawJobs],
      ]),
    },
    { includeSecrets },
  );
}

function hermes(includeSecrets: boolean) {
  return readAgentImportSettings(
    {
      source: "hermes",
      root: ".hermes",
      files: new Map([
        ["config.yaml", hermesConfig],
        [".env", "XAI_API_KEY=placeholder-xai-key\nTELEGRAM_BOT_TOKEN=placeholder-telegram"],
        ["auth.json", hermesAuth],
        ["cron/jobs.json", hermesJobs],
      ]),
    },
    { includeSecrets },
  );
}

describe("OpenClaw settings", () => {
  it("reads the chosen agent's model, falling back to the defaults", () => {
    expect(openclaw(false).model).toEqual({
      title: "openrouter/anthropic/claude-sonnet-4.6",
      provider: "openrouter",
      providerName: "OpenRouter",
      modelId: "anthropic/claude-sonnet-4.6",
      known: true,
    });
    expect(openclaw(false, "workspace-research").model).toMatchObject({
      provider: "xai",
      providerName: "xAI",
      modelId: "grok-4",
    });
  });

  it("maps MCP servers and skips what Rakazo cannot express", () => {
    const settings = openclaw(false);
    expect(settings.mcpServers.map((server) => [server.title, server.config])).toEqual([
      [
        "docs",
        {
          slug: "docs",
          name: "docs",
          description: "",
          enabled: true,
          transport: "streamable_http",
          endpoint: "https://mcp.example.com/mcp",
          headers: {},
        },
      ],
      [
        "files",
        {
          slug: "files",
          name: "files",
          description: "",
          enabled: true,
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          env: {},
        },
      ],
      ["vault", expect.objectContaining({ transport: "stdio", command: "vault-mcp", env: {} })],
    ]);
    expect(settings.mcpServers.map((server) => server.warnings)).toEqual([
      [],
      ["dropped_settings", "local_path"],
      [],
    ]);
    expect(settings.mcpServers[0]!.content).toBe("https://mcp.example.com/mcp\nAuthorization");
    expect(settings.skipped.filter((item) => item.path.startsWith("openclaw.json"))).toEqual([
      { path: "openclaw.json: signin", reason: "unsupported" },
      { path: "openclaw.json: partial", reason: "unsupported" },
    ]);
  });

  it("says what each MCP server needs before it works here", () => {
    const status = (allowed: boolean) =>
      readAgentImportSettings(
        {
          source: "openclaw",
          root: "workspace",
          files: new Map([["openclaw.json", openclawJson]]),
        },
        { includeSecrets: false, stdioAllowed: () => allowed },
      ).mcpServers.map((server) => [server.title, server.status]);
    expect(status(true)).toEqual([
      ["docs", { kind: "needs_setup", needs: [{ kind: "credentials", names: ["Authorization"] }] }],
      [
        "files",
        {
          kind: "needs_setup",
          needs: [
            { kind: "program", name: "npx" },
            { kind: "env", names: ["EXAMPLE_TOKEN"] },
            { kind: "local_paths" },
          ],
        },
      ],
      [
        "vault",
        {
          kind: "needs_setup",
          needs: [
            { kind: "program", name: "vault-mcp" },
            { kind: "env", names: ["TOKEN"] },
          ],
        },
      ],
    ]);
    // Where this deployment cannot run stdio servers, they are not supported here.
    expect(status(false).map(([title, value]) => [title, value])).toEqual([
      ["docs", { kind: "needs_setup", needs: [{ kind: "credentials", names: ["Authorization"] }] }],
      ["files", { kind: "unsupported", reason: "unsupported_command" }],
      ["vault", { kind: "unsupported", reason: "unsupported_command" }],
    ]);
  });

  it("never imports MCP credential values, even with the opt-in", () => {
    const settings = openclaw(true);
    const configs = Object.fromEntries(
      settings.mcpServers.map((server) => [server.title, server.config]),
    );
    expect(configs.docs).toMatchObject({ headers: {} });
    expect(configs.files).toMatchObject({ env: {} });
    expect(configs.vault).toMatchObject({ env: {} });
    const visible = JSON.stringify(settings.mcpServers);
    expect(visible).not.toContain("placeholder-docs-token");
    expect(visible).not.toContain("placeholder-env-token");
  });

  it("turns user jobs into routines and skips OpenClaw's own jobs", () => {
    const settings = openclaw(false);
    expect(
      settings.routines.map(({ name, prompt, cron, timezone, warnings }) => ({
        name,
        prompt,
        cron,
        timezone,
        warnings,
      })),
    ).toEqual([
      {
        name: "check",
        prompt: "Check the inbox",
        cron: "*/30 * * * *",
        timezone: null,
        // The interval's own start time is lost: it now runs on the half hour.
        warnings: ["changed_schedule"],
      },
      {
        name: "morning",
        prompt: "Summarise my day",
        cron: "0 9 * * *",
        timezone: "Asia/Kolkata",
        warnings: ["dropped_settings"],
      },
      {
        name: "evening",
        prompt: "Wrap up",
        cron: "0 18 * * *",
        // An unknown time zone falls back to the space's, and says so.
        timezone: null,
        warnings: ["changed_schedule"],
      },
    ]);
    expect(settings.skipped.filter((item) => item.path.startsWith("cron"))).toEqual([
      { path: "cron/jobs.json: heartbeat-main", reason: "builtin" },
      { path: "cron/jobs.json: Memory Dreaming Promotion", reason: "builtin" },
      { path: "cron/jobs.json: odd", reason: "unsupported" },
      { path: "cron/jobs.json: once", reason: "unsupported" },
    ]);
  });

  it("offers allowlisted provider keys only with the opt-in, never other tokens", () => {
    expect(openclaw(false).apiKeys).toEqual([]);
    expect(openclaw(false).keyValues.size).toBe(0);
    const settings = openclaw(true);
    expect(settings.apiKeys.map((key) => [key.provider, key.source])).toEqual([
      ["anthropic", "openclaw.json"],
      ["deepseek", "DEEPSEEK_API_KEY"],
      ["openrouter", "OPENROUTER_API_KEY"],
    ]);
    expect(Object.fromEntries(settings.keyValues)).toEqual({
      anthropic: "placeholder-anthropic-key",
      deepseek: "placeholder-deepseek-key",
      openrouter: "placeholder-openrouter-key",
    });
    const visible = JSON.stringify({ ...settings, keyValues: undefined });
    for (const secret of [
      "placeholder-gateway-token",
      "placeholder-channel-token",
      "placeholder-telegram-token",
      "placeholder-openrouter-key",
    ]) {
      expect(visible).not.toContain(secret);
    }
  });
});

describe("Hermes settings", () => {
  it("reads the model, MCP servers and jobs", () => {
    const settings = hermes(false);
    expect(settings.model).toMatchObject({
      title: "openrouter/anthropic/claude-sonnet-4.6",
      provider: "openrouter",
      known: true,
    });
    expect(settings.mcpServers.map((server) => server.config.slug)).toEqual(["docs", "files"]);
    expect(settings.mcpServers[1]!.warnings).toEqual(["dropped_settings", "local_path"]);
    expect(settings.routines.map((routine) => [routine.name, routine.cron])).toEqual([
      ["morning", "0 9 * * *"],
      ["check", "0 */2 * * *"],
    ]);
    expect(settings.skipped).toEqual([
      { path: "cron/jobs.json: later", reason: "unsupported" },
      { path: "cron/jobs.json: backup", reason: "unsupported" },
    ]);
  });

  it("reads manual pool keys, config keys and .env keys, but never OAuth grants", () => {
    const settings = hermes(true);
    expect(Object.fromEntries(settings.keyValues)).toEqual({
      google: "placeholder-gemini-key",
      deepseek: "placeholder-pool-key",
      xai: "placeholder-xai-key",
    });
    expect(settings.mcpServers[0]!.config).toMatchObject({ headers: {} });
  });
});

describe("keys with a base URL", () => {
  it("are offered for the provider's own URL and left behind for a proxy", () => {
    const hermesKeys = readAgentImportSettings(
      {
        source: "hermes",
        root: ".hermes",
        files: new Map([
          [
            "config.yaml",
            [
              "model:",
              "  provider: openrouter",
              "  base_url: https://openrouter.ai/api/v1/",
              "  api_key: placeholder-openrouter-key",
              "custom_providers:",
              "  - name: openai",
              "    base_url: https://proxy.example.com/v1",
              "    api_key: placeholder-proxied-key",
            ].join("\n"),
          ],
          [
            ".env",
            "GROQ_API_KEY=placeholder-groq-key\nGROQ_BASE_URL=https://gateway.example.com/v1",
          ],
        ]),
      },
      { includeSecrets: true },
    );
    expect(Object.fromEntries(hermesKeys.keyValues)).toEqual({
      openrouter: "placeholder-openrouter-key",
    });
    const openclawKeys = readAgentImportSettings(
      {
        source: "openclaw",
        root: "workspace",
        files: new Map([
          [
            "openclaw.json",
            JSON.stringify({
              models: {
                providers: {
                  openai: { baseUrl: "https://gateway.example.com/v1", apiKey: "placeholder-gw" },
                  anthropic: { apiKey: "placeholder-anthropic-key" },
                },
              },
            }),
          ],
        ]),
      },
      { includeSecrets: true },
    );
    expect(Object.fromEntries(openclawKeys.keyValues)).toEqual({
      anthropic: "placeholder-anthropic-key",
    });
  });

  it("hold back a provider's key from .env when its config points at a gateway", () => {
    const settings = readAgentImportSettings(
      {
        source: "openclaw",
        root: "workspace",
        files: new Map([
          [
            "openclaw.json",
            JSON.stringify({
              models: { providers: { deepseek: { baseUrl: "https://gateway.example.com/v1" } } },
            }),
          ],
          [".env", "DEEPSEEK_API_KEY=placeholder-gateway-key\nGROQ_API_KEY=placeholder-groq-key"],
        ]),
      },
      { includeSecrets: true },
    );
    expect(Object.fromEntries(settings.keyValues)).toEqual({ groq: "placeholder-groq-key" });
  });
});

describe("helpers", () => {
  it.each([
    ['"placeholder-key" # comment', "placeholder-key"],
    ["'placeholder-key' # comment", "placeholder-key"],
    ['"placeholder # key" # "quoted comment"', "placeholder # key"],
    ["'placeholder\"#suffix' # comment", 'placeholder"#suffix'],
    [String.raw`"placeholder\"#suffix'" # comment`, String.raw`placeholder\"#suffix'`],
    ['placeholder"#suffix', 'placeholder"#suffix'],
  ])("preserves .env key %s through upload and server preparation", (value, expected) => {
    const upload = agentImportUpload(
      [
        { path: ".hermes/SOUL.md", home: "SOUL.md", content: "Direct.\n" },
        {
          path: ".hermes/.env",
          home: ".env",
          content: `OPENAI_API_KEY=${value}\n`,
        },
      ],
      { includeSecrets: true },
    );
    const folder = readAgentImportFolder(upload, { includeSecrets: true })!;
    const settings = readAgentImportSettings(folder, { includeSecrets: true });

    expect(settings.keyValues.get("openai")).toBe(expected);
  });

  it("converts intervals only when a cron fires at exactly that interval", () => {
    expect([1, 15, 30, 60, 120, 180, 360, 1440].map(intervalCron)).toEqual([
      "*/1 * * * *",
      "*/15 * * * *",
      "*/30 * * * *",
      "0 */1 * * *",
      "0 */2 * * *",
      "0 */3 * * *",
      "0 */6 * * *",
      "0 0 * * *",
    ]);
    expect([7, 45, 90, 300, 2880, 0.5].map(intervalCron)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("normalises provider aliases", () => {
    expect(["gemini", "Claude", "x-ai", "openrouter"].map(normalizeImportProvider)).toEqual([
      "google",
      "anthropic",
      "xai",
      "openrouter",
    ]);
  });

  it("parses .env lines", () => {
    expect(parseDotEnv('# c\nexport A=1\nB="two words"\nC=3 # note\n\nbad line')).toEqual({
      A: "1",
      B: "two words",
      C: "3",
    });
  });
});

describe("compatibility", () => {
  const home = (config: string) =>
    readAgentImportSettings(
      { source: "hermes", root: ".hermes", files: new Map([["config.yaml", config]]) },
      { includeSecrets: false, stdioAllowed: (command) => command === "npx" },
    );

  it("marks stdio commands this deployment cannot launch and local paths", () => {
    const settings = home(
      [
        "mcp_servers:",
        "  allowed:",
        "    command: npx",
        "    args: [-y, example-server]",
        "  python:",
        "    command: uvx",
        "    args: [example-server]",
        "  local:",
        "    command: npx",
        "    args: [-y, example-server, /home/example/notes]",
        "  folder:",
        "    command: npx",
        "    args: [-y, example-server]",
        "    cwd: /home/example/project",
      ].join("\n"),
    );
    expect(settings.mcpServers.map((server) => [server.title, server.warnings])).toEqual([
      ["allowed", []],
      ["python", ["unsupported_command"]],
      ["local", ["local_path"]],
      ["folder", ["local_path"]],
    ]);
  });

  it("marks Hermes jobs whose skills, model or toolsets would be dropped", () => {
    const settings = readAgentImportSettings(
      {
        source: "hermes",
        root: ".hermes",
        files: new Map([
          [
            "cron/jobs.json",
            JSON.stringify({
              jobs: [
                {
                  id: "a",
                  name: "plain",
                  prompt: "Hi",
                  schedule: { kind: "cron", expr: "0 9 * * *" },
                },
                {
                  id: "b",
                  name: "skilled",
                  prompt: "Hi",
                  skills: ["arxiv"],
                  schedule: { kind: "cron", expr: "0 9 * * *" },
                },
                {
                  id: "c",
                  name: "pinned",
                  prompt: "Hi",
                  model: "example-model",
                  schedule: { kind: "cron", expr: "0 9 * * *" },
                },
              ],
            }),
          ],
        ]),
      },
      { includeSecrets: false },
    );
    expect(settings.routines.map((routine) => [routine.name, routine.warnings])).toEqual([
      ["plain", []],
      ["skilled", ["dropped_settings"]],
      ["pinned", ["dropped_settings"]],
    ]);
  });
});

describe("credentials inside MCP URLs and arguments", () => {
  it("skip the server instead of storing them in plain text", () => {
    const settings = readAgentImportSettings(
      {
        source: "hermes",
        root: ".hermes",
        files: new Map([
          [
            "config.yaml",
            [
              "mcp_servers:",
              "  query:",
              "    url: https://mcp.example.test/mcp?api_key=placeholder-query-key",
              "  flag:",
              "    command: npx",
              "    args: [server, --token, placeholder-flag-token]",
              "  clean:",
              "    url: https://mcp.example.test/mcp",
            ].join("\n"),
          ],
        ]),
      },
      { includeSecrets: true },
    );
    expect(settings.mcpServers.map((server) => server.title)).toEqual(["clean"]);
    expect(settings.skipped).toEqual([
      { path: "config.yaml: query", reason: "unsupported" },
      { path: "config.yaml: flag", reason: "unsupported" },
    ]);
    expect(JSON.stringify(settings)).not.toContain("placeholder-");
  });
});

describe("Grok Bot export", () => {
  const routine = {
    instruction: "Run the weekly account review.",
    trigger: "schedule",
    schedule_cron: "0 8 * * 1-5",
  };
  const [bot] = parseGrokBotExport(
    JSON.stringify({
      format: "grok-bot-export",
      version: 1,
      bots: [
        {
          name: "Bramble",
          skills: [{ name: "Weekly Account Health", instructions: "List accounts at risk." }],
          routines: [
            {
              ...routine,
              name: "Monday review",
              timezone: "America/New_York",
              skills: ["Weekly Account Health"],
            },
            { ...routine, name: "Elsewhere", timezone: "Mars/Base" },
            { name: "Support", instruction: "Answer #support.", trigger: "slack" },
            { name: "Unread", trigger: "schedule", schedule_cron: "0 9 * * *" },
          ],
          apps: [
            {
              name: "Linear",
              mcp_url: "https://mcp.example.com/mcp",
              headers: { Authorization: "" },
            },
            { name: "Plain", mcp_url: "http://mcp.example.com/mcp" },
            { name: "Signed", mcp_url: "https://mcp.example.com/mcp?sig=abc123" },
            { name: "Keyed", mcp_url: "https://mcp.example.com/a1b2c3d4e5f6g7h8i9j0k1l2m3" },
            { name: "Gmail" },
            // Built from parts so no scanner mistakes this file for a leak.
            { name: ["gh", "p_", "Ab3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zAb3dE5"].join("") },
            {
              name: "Headed",
              mcp_url: "https://mcp.example.com/mcp",
              headers: { [["gh", "p_", "Ab3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zAb3dE5"].join("")]: "" },
            },
          ],
        },
      ],
    }),
  );
  const settings = readGrokBotImportSettings(bot!);

  it("turns scheduled routines into routines that use the saved skill names", () => {
    expect(settings.routines).toMatchObject([
      {
        id: "routine:0",
        name: "Monday review",
        cron: "0 8 * * 1-5",
        timezone: "America/New_York",
        prompt: "Run the weekly account review.\n\nUse these skills: @weekly-account-health.",
        warnings: [],
      },
      { id: "routine:1", timezone: null, warnings: ["changed_schedule"] },
    ]);
  });

  it("carries remote MCP addresses without a key and lists what is left behind", () => {
    expect(settings.mcpServers).toMatchObject([
      {
        id: "mcp:0",
        title: "Linear",
        config: { transport: "streamable_http", endpoint: "https://mcp.example.com/mcp" },
        status: { kind: "needs_setup", needs: [{ kind: "credentials", names: ["Authorization"] }] },
      },
    ]);
    expect(settings.skipped).toEqual([
      { path: "routines: Unread", reason: "unsupported" },
      { path: "apps: Plain", reason: "unsupported" },
      { path: "apps: Signed", reason: "unsupported" },
      { path: "apps: Keyed", reason: "unsupported" },
      { path: "apps: Gmail", reason: "reconnect" },
      { path: "apps: 6", reason: "unsupported" },
      { path: "apps: 7", reason: "unsupported" },
    ]);
    expect(settings.model).toBeNull();
    expect(settings.apiKeys).toEqual([]);
  });
});

it("keeps scheduled routine conditions and refuses oversized prompts", () => {
  const read = (instruction: string) => {
    const [bot] = parseGrokBotExport(
      JSON.stringify({
        bots: [
          {
            name: "Example",
            routines: [
              {
                name: "Daily",
                instruction,
                cron: "0 8 * * *",
                schedule_text: "Every morning",
                trigger_details: "Only when a report is due",
              },
            ],
          },
        ],
      }),
    );
    return readGrokBotImportSettings(bot!);
  };
  expect(read("Review reports").routines[0]?.prompt).toBe(
    "Review reports\n\nOnly when a report is due\n\nEvery morning",
  );
  expect(read("x".repeat(100001)).routines).toEqual([]);
  expect(read("x".repeat(100001)).skipped).toHaveLength(1);
});
