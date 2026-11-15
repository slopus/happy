import { phoneCallSettings, resolveEncryptionKey, uploadSizeFromEnv } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { resolveDeploymentModel } from "./deployment-model.js";
import { mcpStdioOptionsFromEnv } from "./mcp-connector.js";
import { runRuntimeEnvFromProcess } from "./run-runtime.js";

// What the worker read inline before it shared the runtime builder with the API.
function previousWorkerValues(source: NodeJS.ProcessEnv) {
  const { key, configured, provider, model } = resolveDeploymentModel(source);
  return {
    dataDir: source.DATA_DIR ?? "./data",
    encryptionKey: resolveEncryptionKey(source),
    composioApiKey: source.COMPOSIO_API_KEY,
    cursorApiKey: source.CURSOR_API_KEY,
    deploymentModelKey: key,
    deploymentModelConfigured: configured,
    // The API's ambient team-chat judge settings, which the worker's jobs now use too.
    defaultProvider: provider,
    defaultModel: model,
    teamChatJudgeProvider: source.TEAM_CHAT_JUDGE_PROVIDER?.trim() || undefined,
    teamChatJudgeModel: source.TEAM_CHAT_JUDGE_MODEL?.trim() || undefined,
    mcpStdioEnabled: source.MCP_STDIO_ENABLED === "true",
    mcpStdioAllowedCommands: (source.MCP_STDIO_ALLOWED_COMMANDS ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    mcpStdio: mcpStdioOptionsFromEnv(source),
    mcpAllowPrivateEndpoint: source.MCP_ALLOW_PRIVATE_ENDPOINT === "true",
    pipedreamClientId: source.PIPEDREAM_CLIENT_ID,
    pipedreamClientSecret: source.PIPEDREAM_CLIENT_SECRET,
    pipedreamProjectId: source.PIPEDREAM_PROJECT_ID,
    pipedreamEnvironment: source.PIPEDREAM_ENVIRONMENT,
    ticketBoardEnabled: source.TICKET_BOARD_ENABLED === "true",
    ...phoneCallSettings(source),
    maxUploadSizeBytes: uploadSizeFromEnv(source),
    inboundEmailDomain: source.INBOUND_EMAIL_DOMAIN?.trim().toLowerCase() || undefined,
  };
}

describe("runRuntimeEnvFromProcess", () => {
  it.each<NodeJS.ProcessEnv>([
    { NODE_ENV: "test" },
    {
      NODE_ENV: "test",
      DATA_DIR: "/var/rakazo",
      ENCRYPTION_KEY: "offline-encryption-key-at-least-32-chars",
      COMPOSIO_API_KEY: " composio-key ",
      CURSOR_API_KEY: " cursor-key ",
      PI_DEFAULT_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "openrouter-key",
      MCP_STDIO_ENABLED: "true",
      MCP_STDIO_ALLOWED_COMMANDS: " npx, uvx ,,",
      MCP_STDIO_IDLE_MS: "1000",
      MCP_ALLOW_PRIVATE_ENDPOINT: "true",
      PIPEDREAM_CLIENT_ID: " client ",
      PIPEDREAM_CLIENT_SECRET: "secret",
      PIPEDREAM_PROJECT_ID: "project",
      PIPEDREAM_ENVIRONMENT: "production",
      TICKET_BOARD_ENABLED: "true",
      PHONE_CALLS_ENABLED: "true",
      PHONE_CALL_RING_SECONDS: "30",
      MAX_UPLOAD_SIZE_MB: "20",
      INBOUND_EMAIL_DOMAIN: " Bots.Example.Test ",
      TEAM_CHAT_JUDGE_PROVIDER: " openrouter ",
      TEAM_CHAT_JUDGE_MODEL: "small-model",
    },
    { NODE_ENV: "test", INBOUND_EMAIL_DOMAIN: "  ", PIPEDREAM_ENVIRONMENT: "staging" },
  ])("reads the values the worker read before (%#)", (source) => {
    expect(runRuntimeEnvFromProcess(source)).toEqual(previousWorkerValues(source));
  });
});
