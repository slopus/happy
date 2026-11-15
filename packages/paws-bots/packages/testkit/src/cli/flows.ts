import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { computerTestSandbox } from "../computer-test-config.js";
import { FLOWS } from "../flows/index.js";
import { validateFlowLimits } from "../flows/limits.js";
import type { FlowResult } from "../flows/runner.js";
import { disposableDatabaseEnv, startPostgres } from "./postgres.js";

const { values } = parseArgs({
  options: {
    list: { type: "boolean", default: false },
    flow: { type: "string", default: "weekly-shopping" },
    sandbox: { type: "string", default: "boat" },
    model: { type: "string", default: "openai/gpt-6-luna" },
    "user-model": { type: "string", default: "anthropic/claude-haiku-5.5" },
    "judge-model": { type: "string", default: "anthropic/claude-haiku-5.5" },
    "deadline-min": { type: "string", default: "45" },
    "max-turns": { type: "string", default: "20" },
    "spend-cap-usd": { type: "string", default: "10" },
    output: { type: "string", default: "test-report/flows" },
  },
});

async function main() {
  if (values.list) {
    for (const flow of FLOWS) console.log(`${flow.id}\t${flow.purpose}`);
    return;
  }
  const flow = FLOWS.find((candidate) => candidate.id === values.flow);
  if (!flow) throw new Error(`Unknown flow ${values.flow}; see --list`);
  // Docker is for debugging the harness locally; hosted providers are the point of a flow.
  const sandbox =
    values.sandbox === "docker"
      ? ({ provider: "docker", apiKeyEnv: undefined } as const)
      : computerTestSandbox(values.sandbox);
  loadRootEnv();
  for (const key of [sandbox.apiKeyEnv, "OPENROUTER_API_KEY"].filter(Boolean) as string[]) {
    if (!process.env[key]) throw new Error(`${key} is required for pnpm test:flows`);
  }
  // Checked before the database, computer and models start: a limit the CLI cannot parse must
  // stop the run, not silently disable the deadline, turn and spend caps as NaN.
  const deadlineMin = Number(values["deadline-min"]);
  const maxUserTurns = Number(values["max-turns"]);
  const spendCapUsd = Number(values["spend-cap-usd"]);
  validateFlowLimits({ deadlineMin, maxUserTurns, spendCapUsd });
  const startedAt = new Date();
  const outputDir = path.resolve(
    values.output,
    `${startedAt.toISOString().replace(/[:.]/g, "-")}-${flow.id}-${sandbox.provider}`,
  );
  mkdirSync(outputDir, { recursive: true });
  const logLines: string[] = [];
  const log = (line: string) => {
    const stamped = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
    logLines.push(stamped);
    console.log(stamped);
  };

  // This CLI owns a disposable database; it never touches an inherited one.
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-flows-"));
  const database = await startPostgres();
  let stop: (() => Promise<void>) | undefined;
  let closeSupervisor: (() => Promise<void>) | undefined;
  try {
    Object.assign(process.env, {
      ...disposableDatabaseEnv(database.getConnectionUri()),
      WAKEUP_DRIVER: "memory",
      SANDBOX_PROVIDER: sandbox.provider,
      ...(sandbox.provider === "docker"
        ? {
            RAKAZO_COMPUTER_IMAGE: process.env.RAKAZO_COMPUTER_IMAGE || "rakazo/computer:local",
            SANDBOX_CONTROL_VIA_LOOPBACK: "true",
            SANDBOX_SCREEN_NETWORK: "published",
            SANDBOX_SCREEN_HOST: "127.0.0.1",
          }
        : {}),
      AGENT_RUNTIME: "pi",
      PI_DEFAULT_PROVIDER: "openrouter",
      PI_DEFAULT_MODEL: values.model,
      BETTER_AUTH_SECRET: "synthetic-flow-auth-secret-at-least-32-characters",
      ENCRYPTION_KEY: "synthetic-flow-encryption-key-at-least-32-characters",
      SANDBOX_SUPERVISOR_TOKEN: "synthetic-flow-supervisor-token-at-least-32-chars",
      SCREEN_PROXY_SECRET: "synthetic-flow-screen-secret-at-least-32-characters",
      BETTER_AUTH_URL: "http://127.0.0.1:5173",
      WEB_ORIGIN: "http://127.0.0.1:5173",
      SIGNUPS_ENABLED: "true",
      SIGNUP_ALLOWLIST: "",
      DATA_DIR: dataDir,
      LOG_LEVEL: "error",
      COMPOSIO_API_KEY: "",
      CLOUD_AGENT_PROVIDER: "",
      EMAIL_PROVIDER: "none",
      // Flow MCP servers, such as connect-mcp's task tracker, listen on loopback in this process.
      MCP_ALLOW_PRIVATE_ENDPOINT: "true",
      // Billing would require a funded credits account; flows pay the model directly.
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      STRIPE_PRICE_ID: "",
    });
    // Parallel runs share one generated client: generate it once per schema, under a lock, since
    // generating it from several runs at once collides on its folder.
    await withLock(path.join(tmpdir(), "rakazo-flows-prisma-generate.lock"), () => {
      // The schema and the installed generator together decide the generated client.
      const schema = createHash("sha256")
        .update(readFileSync(path.resolve("packages/db/prisma/schema.prisma")))
        .update(readFileSync(path.resolve("packages/db/node_modules/prisma/package.json")))
        .digest("hex");
      const stamp = path.resolve("packages/db/src/generated/prisma/.flows-schema-hash");
      if (existsSync(stamp) && readFileSync(stamp, "utf8") === schema) return;
      execFileSync("pnpm", ["--filter", "@rakazo/db", "generate"], {
        stdio: "pipe",
        timeout: 300_000,
      });
      writeFileSync(stamp, schema);
    });
    execFileSync("pnpm", ["--filter", "@rakazo/db", "exec", "prisma", "migrate", "deploy"], {
      stdio: "pipe",
      timeout: 600_000,
    });
    if (sandbox.provider === "docker") {
      // An isolated supervisor, never a dev one another checkout may be running.
      const { supervisorApp } = await import("@rakazo/sandbox-supervisor");
      const server = serve({ fetch: supervisorApp.fetch, hostname: "127.0.0.1", port: 0 });
      await new Promise<void>((resolve, reject) => {
        if (server.listening) return resolve();
        server.once("error", reject);
        server.once("listening", () => resolve());
      });
      closeSupervisor = () => new Promise((resolve) => server.close(() => resolve()));
      process.env.SANDBOX_SUPERVISOR_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }
    // Import after generation; the app's barrel exports load Prisma.
    const { createApp } = await import("@rakazo/api/app");
    const { runFlow } = await import("../flows/runner.js");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: sandbox.provider,
      agentRuntime: "pi",
      e2bApiKey: process.env.E2B_API_KEY,
      novitaApiKey: process.env.NOVITA_API_KEY,
      sandboxTemplate: process.env.SANDBOX_TEMPLATE,
      boatApiKey: process.env.BOAT_API_KEY,
      boatApiUrl: process.env.BOAT_API_URL,
      wakeupDriver: "memory",
    });
    stop = handles.stop;
    await handles.prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { defaultModelProvider: "openrouter", defaultModelId: values.model },
    });
    const harnessModel = (id: string) => ({
      provider: "openrouter",
      id,
      apiKey: process.env.OPENROUTER_API_KEY!,
      maxTokens: 8192,
    });
    log(
      `flow ${flow.id} on ${sandbox.provider}, bot ${values.model}, user ${values["user-model"]}`,
    );
    const result = await runFlow(handles, flow, {
      sandboxKind: sandbox.provider,
      userModel: harnessModel(values["user-model"]!),
      judgeModel: harnessModel(values["judge-model"]!),
      deadlineMs: deadlineMin * 60_000,
      maxUserTurns,
      spendCapUsd,
      log,
      framesDir: path.join(outputDir, "frames"),
    });
    const report = {
      startedAt: startedAt.toISOString(),
      sandbox: sandbox.provider,
      botModel: values.model,
      userModel: values["user-model"],
      judgeModel: values["judge-model"],
      ...result,
    };
    writeFileSync(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(path.join(outputDir, "report.md"), markdownReport(report));
    writeFileSync(path.join(outputDir, "log.txt"), `${logLines.join("\n")}\n`);
    const { htmlReport, writeScreenVideo } = await import("../flows/report.js");
    writeFileSync(
      path.join(outputDir, "report.html"),
      htmlReport(report, writeScreenVideo(outputDir, result.frames)),
    );
    log(
      `${result.status.toUpperCase()} in ${Math.round(result.durationMs / 1000)}s, report: ${path.join(outputDir, "report.html")}`,
    );
    if (result.status !== "passed") process.exitCode = 1;
  } finally {
    await stop?.().catch(() => undefined);
    await closeSupervisor?.();
    await database.stop().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/**
 * A directory lock across processes, released in finally. A run killed outright can leave it
 * behind; waiting runs then stop with its path instead of guessing who still holds it.
 */
async function withLock<T>(lock: string, work: () => T): Promise<T> {
  const deadline = Date.now() + 600_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() > deadline)
        throw new Error(
          `Timed out waiting for ${lock}; remove it if no other flow run is starting`,
        );
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  try {
    return work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function markdownReport(report: FlowResult & { sandbox: string; botModel?: string }) {
  const lines = [
    `# ${report.flow}: ${report.status}`,
    "",
    `Sandbox ${report.sandbox}, bot model ${report.botModel}. Ended by ${report.endedBy} after ${Math.round(report.durationMs / 1000)}s.`,
    `Bot cost $${report.botCostUsd.toFixed(3)}, harness ${report.harnessCostUsd === null ? `${report.harnessTokens.input} input and ${report.harnessTokens.output} output tokens (price not reported)` : `cost $${report.harnessCostUsd.toFixed(3)}`}, ${report.toolCalls} tool calls.`,
    ...(report.error ? ["", `Error: ${report.error}`] : []),
    "",
    "## Checks",
    ...report.criteria.map(
      (criterion) =>
        `- ${criterion.pass ? "pass" : "FAIL"} ${criterion.id}${criterion.detail ? `: ${criterion.detail}` : ""}`,
    ),
    ...(report.judgment
      ? [`- ${report.judgment.pass ? "pass" : "FAIL"} judge: ${report.judgment.reason}`]
      : []),
    "",
    "## Runs",
    ...report.runs.map(
      (run) =>
        `- ${run.routine ? "routine" : run.trigger}: ${run.status}, ${run.botMessages} bot messages${run.error ? ` (${run.error})` : ""}`,
    ),
    ...report.routines.map(
      (routine) =>
        `- routine "${routine.name}" ${routine.crons.join(", ")}${routine.active ? "" : " (paused)"}: ${routine.prompt.replace(/\n/g, " ")}`,
    ),
    "",
    "## Tools",
    ...Object.entries(report.toolCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `- ${name}: ${count}`),
    "",
    "## Transcript",
    ...report.transcript.map(
      (entry) =>
        `**${entry.from}${entry.wake ? ` (wake ${entry.wake})` : ""}:** ${entry.text.replace(/\n/g, "  \n")}\n`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
