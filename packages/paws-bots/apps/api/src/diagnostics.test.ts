import { describe, expect, it } from "vitest";
import type { DiagnosticsInput, DiagnosticsServer } from "./diagnostics.js";
import { opaque, renderDiagnostics, safeMessage } from "./diagnostics.js";

const SECRETS = [
  "sk-live-0123456789abcdef",
  "https://admin:hunter2@mcp.internal.example/sse",
  "owner@example.com",
  "/home/alice/.config/acme/token.json",
  "Acme Payroll",
  "acme-payroll",
  "/usr/local/bin/acme-mcp",
  "10.1.2.3",
  "space_private_1",
  "user_private_1",
  "bot_private_1",
  "server_private_1",
  "run_private_1",
];

function server(overrides: Partial<DiagnosticsServer> = {}): DiagnosticsServer {
  return {
    id: "server_private_1",
    spaceId: "space_private_1",
    userId: "user_private_1",
    transport: "stdio",
    enabled: true,
    allSpaces: false,
    availableIn: [],
    healthStatus: "error",
    healthMessage:
      "Acme Payroll failed: spawn /usr/local/bin/acme-mcp ENOENT while calling https://admin:hunter2@mcp.internal.example/sse for owner@example.com with sk-live-0123456789abcdef from 10.1.2.3 and /home/alice/.config/acme/token.json",
    healthToolCount: 7,
    healthCheckedAt: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  };
}

function input(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    env: {
      gitSha: "abc1234",
      nodeEnv: "production",
      agentRuntime: "pi",
      sandboxProvider: "docker",
      cloudAgentProvider: "none",
      deploymentModelConfigured: true,
      contentEncryption: true,
      wakeupDriver: "graphile",
      mcpStdioEnabled: true,
      mcpStdioAllowedCommands: ["/usr/local/bin/acme-mcp", "npx"],
      mcpAllowPrivateEndpoint: false,
      ticketBoardEnabled: false,
      userDevicesEnabled: true,
      phoneCallsEnabled: false,
      secretStore: "encrypted",
    },
    nodeVersion: "v24.0.0",
    database: {
      reachable: true,
      migrationsInImage: ["20261001000000_first", "20261002000000_second"],
      appliedMigrations: ["20261001000000_first"],
      failedMigrations: 0,
    },
    bots: [
      {
        id: "bot_private_1",
        spaceId: "space_private_1",
        userId: "user_private_1",
        archived: false,
      },
    ],
    assignments: [
      {
        botId: "bot_private_1",
        spaceId: "space_private_1",
        userId: "user_private_1",
        server: server(),
      },
    ],
    unassignedServers: [],
    runs: [
      {
        id: "run_private_1",
        botId: "bot_private_1",
        status: "succeeded",
        trigger: "message",
        createdAt: new Date("2026-10-02T00:00:00Z"),
      },
    ],
    ...overrides,
  };
}

describe("diagnostics report", () => {
  it("prints none of the identifying or secret values it was given", () => {
    const report = renderDiagnostics(input());
    for (const secret of SECRETS) expect(report).not.toContain(secret);
    for (const fragment of ["hunter2", "alice", "example", "acme", "Acme", "Payroll", "sk-live"])
      expect(report).not.toContain(fragment);
  });

  it("keeps what is needed to debug an MCP server", () => {
    const report = renderDiagnostics(input());
    expect(report).toContain("- MCP_STDIO_ENABLED: on");
    expect(report).toContain("- MCP_STDIO_ALLOWED_COMMANDS: 2");
    expect(report).toContain("- Pending: 20261002000000_second");
    expect(report).toContain(`#### Bot ${opaque("bot_private_1")}`);
    expect(report).toContain(`| ${opaque("server_private_1")} | stdio | on | error | 7 |`);
    expect(report).toContain(
      "| ok | … failed: spawn … ENOENT while calling … for … with … from … and … |",
    );
    expect(report).toContain(
      `| ${opaque("run_private_1")} | ${opaque("bot_private_1")} | succeeded | message |`,
    );
  });

  it("flags assignments the MCP connector would silently skip", () => {
    const report = renderDiagnostics(
      input({
        assignments: [
          {
            botId: "bot_private_1",
            spaceId: "space_other",
            userId: "user_other",
            server: server({ userId: "user_third" }),
          },
        ],
      }),
    );
    expect(report).toContain(
      "space differs from bot; user differs from bot; user differs from server; server not available in space",
    );
  });

  it("does not echo unexpected free-form values from enum-like fields", () => {
    const report = renderDiagnostics(
      input({
        env: { ...input().env, agentRuntime: "https://x:y@h", gitSha: "not a sha" },
        runs: [{ ...input().runs[0]!, trigger: "Owner@Example.com" }],
      }),
    );
    expect(report).toContain("- AGENT_RUNTIME: other");
    expect(report).toContain("- Revision: unknown");
    expect(report).not.toContain("x:y@h");
    expect(report).not.toContain("Owner@Example.com");
  });

  it("reports an unreadable migration table and an unreachable database", () => {
    const unreadable = renderDiagnostics(
      input({ database: { reachable: true, migrationsInImage: ["20261001000000_first"] } }),
    );
    expect(unreadable).toContain("not readable by the app's database login");
    const down = renderDiagnostics(input({ database: { reachable: false } }));
    expect(down).toContain("- Connection: failed");
    expect(down).not.toContain("### Bots");
  });
});

describe("safeMessage", () => {
  it("keeps error wording, codes and short numbers", () => {
    expect(safeMessage("Connection closed. MCP error -32000: Connection closed")).toBe(
      "Connection closed. MCP error -32000: Connection closed",
    );
    expect(safeMessage("connect ECONNREFUSED 127.0.0.1:3000")).toBe("connect ECONNREFUSED …");
    expect(safeMessage("Request failed with status 401")).toBe("Request failed with status 401");
  });

  it("drops names, commands, packages and quoted values", () => {
    expect(safeMessage("Token for Alice expired")).toBe("Token for … expired");
    expect(safeMessage("user alice not found")).toBe("… not found");
    expect(safeMessage("spawn acme-mcp ENOENT")).toBe("spawn … ENOENT");
    expect(safeMessage("package secret-pkg not found")).toBe("package … not found");
    expect(safeMessage("command 'npx --yes secret-pkg' is not allowed")).toBe(
      "command … is not allowed",
    );
  });
});
