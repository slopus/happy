import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { Browser, BrowserContext, CDPSession, Page } from "@playwright/test";
import { chromium } from "@playwright/test";
import type { createApp } from "@rakazo/api/app";
import { abortableDelay, RESPONSE_STREAMING_STORAGE_KEY } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { createThreadEvents, createThreadMessage, runAsSystem } from "@rakazo/db";
import type { NumericSummary } from "../performance-report.js";
import {
  parseTcpPort,
  percentageDelta,
  roundedSummary,
  roundMetric,
} from "../performance-report.js";
import {
  benchmarkThreadMessages,
  STREAM_END,
  STREAMED_REPLY,
  streamChunks,
} from "../web-chat-fixture.js";
import {
  argument,
  benchmarkEnvironment,
  cdpMetrics,
  migrateDatabase,
  output,
  positiveInteger,
  repositoryRoot as root,
  run,
  safeName,
  startBenchmarkDatabase,
  startPreview,
  stopProcess,
  waitForUrl,
} from "./performance-stack.js";

const SCHEMA_VERSION = 1;
const VIEWPORT = { width: 1440, height: 900 };

/** Every reported metric, in table order; `lowerIsBetter` is true for all of them. */
const METRICS = [
  ["coldOpenMs", "Cold open to transcript painted", "ms"],
  ["cachedSwitchMs", "Switch to a cached chat", "ms"],
  ["olderPageMs", "Load one older page", "ms"],
  ["scrollFrameP50Ms", "Scroll frame time p50", "ms"],
  ["scrollFrameP95Ms", "Scroll frame time p95", "ms"],
  ["scrollLongTasks", "Scroll long tasks", "count"],
  ["scrollLongTaskMs", "Scroll long-task total", "ms"],
  ["scrollLayoutMs", "Scroll layout", "ms"],
  ["scrollRecalcStyleMs", "Scroll style recalc", "ms"],
  ["scrollScriptMs", "Scroll script", "ms"],
  ["scrollTaskMs", "Scroll main-thread total", "ms"],
  ["scrollTaskPerFrameMs", "Scroll main-thread per frame", "ms"],
  ["streamTaskPerUpdateMs", "Stream main-thread per update", "ms"],
  ["streamScriptPerUpdateMs", "Stream script per update", "ms"],
  ["streamLayoutPerUpdateMs", "Stream layout per update", "ms"],
  ["streamRecalcStylePerUpdateMs", "Stream style recalc per update", "ms"],
  ["streamFrameP95Ms", "Stream frame time p95", "ms"],
  ["streamLongTasks", "Stream long tasks", "count"],
  ["streamLongTaskMs", "Stream long-task total", "ms"],
  ["streamTailLatencyMs", "Last token sent to painted", "ms"],
  ["heapAfterOpenMiB", "JS heap after open", "MiB"],
  ["domNodesAfterOpen", "DOM elements after open", "count"],
  ["heapAllLoadedMiB", "JS heap, all pages loaded", "MiB"],
  ["domNodesAllLoaded", "DOM elements, all pages loaded", "count"],
] as const;
type MetricKey = (typeof METRICS)[number][0];

interface WebChatReport {
  schemaVersion: typeof SCHEMA_VERSION;
  label: string;
  createdAt: string;
  environment: Record<string, string | number | boolean>;
  fixture: {
    sizes: number[];
    samples: number;
    scrollStepPx: number;
    streamUpdates: number;
    streamIntervalMs: number;
    threadBytes: Record<string, number>;
  };
  results: Record<string, { samples: Partial<Record<MetricKey, number>>[]; summary: Summary }>;
}
type Summary = Partial<Record<MetricKey, NumericSummary>>;

loadRootEnv();

async function benchmark() {
  const label = argument("--label") ?? "baseline";
  const samples = positiveInteger(argument("--samples") ?? "5");
  const sizes = (argument("--sizes") ?? "50,100,500").split(",").map(positiveInteger);
  const scrollStepPx = positiveInteger(argument("--scroll-step") ?? "150");
  const streamUpdates = positiveInteger(argument("--stream-updates") ?? "100");
  const streamIntervalMs = positiveInteger(argument("--stream-interval") ?? "50");
  const skipBuild = process.argv.includes("--skip-build");
  const webPort = parseTcpPort(process.env.PERF_WEB_PORT ?? "55410", "PERF_WEB_PORT");
  const apiPort = parseTcpPort(process.env.PERF_API_PORT ?? "55411", "PERF_API_PORT");
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const reportPath =
    argument("--out") ??
    path.join(root, ".context/performance", `web-chat-${safeName(label)}.json`);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "rakazo-web-chat-performance-"));
  const database = await startBenchmarkDatabase(
    argument("--database-url") ?? process.env.PERF_DATABASE_URL,
  );
  let preview: ChildProcess | undefined;
  let server: ReturnType<typeof serve> | undefined;
  let handles: Awaited<ReturnType<typeof createApp>> | undefined;
  let browser: Browser | undefined;
  try {
    const env = benchmarkEnvironment({
      databaseUrl: database.url,
      webPort,
      apiPort,
      dataDir: path.join(temporaryRoot, "data"),
    });
    Object.assign(process.env, env);
    if (!skipBuild) run("pnpm", ["--filter", "@rakazo/web", "build"], env);
    migrateDatabase(env);

    const [{ InMemoryRealtimeFanout }, { createApp }] = await Promise.all([
      import("@rakazo/adapters"),
      import("@rakazo/api/app"),
    ]);
    // Shared with the event writer below, so streamed updates reach the app's subscribers.
    const realtime = new InMemoryRealtimeFanout();
    handles = await createApp({ databaseUrl: database.url, prisma: undefined, realtime });
    const app = handles.app;
    server = serve({
      fetch: (request) => app.fetch(request),
      hostname: "127.0.0.1",
      port: apiPort,
    });
    await waitForUrl(`${apiOrigin}/health`);
    preview = startPreview(env, webPort);
    await waitForUrl(webOrigin);

    browser = await chromium.launch({ channel: "chromium", headless: true });
    const bench: Bench = {
      browser,
      webOrigin,
      prisma: handles.prisma,
      events: createThreadEvents(handles.prisma, realtime),
      scrollStepPx,
      streamUpdates,
      streamIntervalMs,
    };
    const account = await prepareAccount(bench, sizes);

    const results: WebChatReport["results"] = {};
    for (const thread of account.threads) {
      const rows: Partial<Record<MetricKey, number>>[] = [];
      for (let sample = 0; sample < samples; sample += 1) {
        console.log(`[${label}] ${thread.size} messages, sample ${sample + 1}/${samples}`);
        rows.push({
          ...(await measureOpenScrollAndStream(bench, account, thread)),
          cachedSwitchMs: await measureCachedSwitch(bench, account, thread),
        });
      }
      results[String(thread.size)] = { samples: rows, summary: summarizeRows(rows) };
    }

    const report: WebChatReport = {
      schemaVersion: SCHEMA_VERSION,
      label,
      createdAt: new Date().toISOString(),
      environment: {
        // A copy synced without .git, as on a benchmark machine, is named by its label.
        gitSha: gitOutput(["rev-parse", "HEAD"]) ?? "unknown",
        gitDirty: (gitOutput(["status", "--porcelain"]) ?? "").length > 0,
        platform: process.platform,
        arch: process.arch,
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        cpuCount: os.cpus().length,
        node: process.version,
        chromium: browser.version(),
        playwright: createRequire(import.meta.url)("@playwright/test/package.json").version,
        buildMode: "production-vite-preview",
        viewport: `${VIEWPORT.width}x${VIEWPORT.height}`,
      },
      fixture: {
        sizes,
        samples,
        scrollStepPx,
        streamUpdates,
        streamIntervalMs,
        threadBytes: Object.fromEntries(account.threads.map((t) => [String(t.size), t.bytes])),
      },
      results,
    };
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nWeb chat performance report: ${reportPath}\n`);
    console.log(renderReport(report));
  } finally {
    await browser?.close().catch(() => undefined);
    if (preview) await stopProcess(preview);
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await handles?.stop().catch(() => undefined);
    await database
      .stop()
      .catch((error) => console.warn("Could not drop benchmark database", error));
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

function gitOutput(args: string[]) {
  try {
    return output("git", args);
  } catch {
    return undefined;
  }
}

type BenchWindow = Window & {
  __benchPaint?: { paintedAt: number | null };
  __benchStream?: { doneAt: number | null };
};

interface Bench {
  browser: Browser;
  webOrigin: string;
  prisma: PrismaClient;
  events: ThreadEvents;
  scrollStepPx: number;
  streamUpdates: number;
  streamIntervalMs: number;
}

interface BenchThread {
  size: number;
  name: string;
  botId: string;
  threadId: string;
  spaceId: string;
  lastMessageId: string;
  bytes: number;
}

interface Account {
  storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;
  userId: string;
  homeBotName: string;
  threads: BenchThread[];
}

/** Signs up through the auth API like the e2e helpers, then seeds one chat per thread size. */
async function prepareAccount(bench: Bench, sizes: number[]): Promise<Account> {
  const context = await newContext(bench);
  try {
    const page = await context.newPage();
    const email = `benchmark-${Date.now()}@rakazo.test`;
    const response = await page.request.post("/api/auth/sign-up/email", {
      data: { email, password: "password12", name: "Benchmark User" },
      headers: { origin: bench.webOrigin },
    });
    if (!response.ok()) throw new Error(`sign-up ${response.status()}: ${await response.text()}`);
    await page.goto("/onboarding");
    const skip = page.getByRole("button", { name: "Skip", exact: true });
    const composer = page.getByRole("combobox", { name: "Message Chief" });
    await skip.or(composer).first().waitFor({ timeout: 30_000 });
    if (await skip.isVisible()) await skip.click();
    await composer.waitFor({ timeout: 30_000 });
    // Live reply text is a per-user setting, off until the user turns it on.
    await page.evaluate((key) => localStorage.setItem(key, "on"), RESPONSE_STREAMING_STORAGE_KEY);

    const user = await runAsSystem("benchmark seed", () =>
      bench.prisma.user.findFirstOrThrow({ where: { email }, select: { id: true } }),
    );
    const threads: BenchThread[] = [];
    for (const size of sizes) {
      const name = `Bench ${size}`;
      const created = await rpc<{ id: string }>(page, "bots/create", {
        name,
        title: "",
        description: "",
        notifyOnFinish: false,
        computerMode: "team",
      });
      threads.push(await seedThread(bench.prisma, created.id, name, size));
    }
    return {
      storageState: await context.storageState(),
      userId: user.id,
      homeBotName: "Chief",
      threads,
    };
  } finally {
    await context.close();
  }
}

async function seedThread(prisma: PrismaClient, botId: string, name: string, size: number) {
  return runAsSystem("benchmark seed", async () => {
    const bot = await prisma.bot.findUniqueOrThrow({
      where: { id: botId },
      select: { spaceId: true, thread: { select: { id: true } } },
    });
    const threadId = bot.thread?.id;
    if (!threadId) throw new Error(`${name} has no thread`);
    let lastMessageId = "";
    let bytes = 0;
    for (const message of benchmarkThreadMessages(size)) {
      bytes += JSON.stringify(message.blocks).length;
      const created = await createThreadMessage(prisma, {
        threadId,
        role: message.role,
        blocks: message.blocks,
        botId: message.role === "bot" ? botId : undefined,
        markUnread: false,
      });
      lastMessageId = created.id;
    }
    return { size, name, botId, threadId, spaceId: bot.spaceId, lastMessageId, bytes };
  });
}

async function rpc<T>(page: Page, procedure: string, body: unknown): Promise<T> {
  const response = await page.request.post(`/rpc/${procedure}`, { data: { json: body } });
  const parsed = (await response.json()) as { json?: T; error?: { message?: string } };
  if (!response.ok() || parsed.error) {
    throw new Error(`${procedure} ${response.status()}: ${parsed.error?.message ?? "failed"}`);
  }
  return parsed.json as T;
}

function newContext(bench: Bench, storageState?: Account["storageState"]) {
  return bench.browser.newContext({
    baseURL: bench.webOrigin,
    viewport: VIEWPORT,
    locale: "en-US",
    storageState,
  });
}

/**
 * Records, in `window.__benchPaint`, the first frame after the message is drawn inside the
 * transcript's viewport: a rAF that finds it there runs before that frame paints, so the next
 * rAF runs after it.
 */
function paintWatcher(messageId: string, startedAt: string) {
  return `(() => {
    const target = ${JSON.stringify(messageId)};
    const state = { startedAt: ${startedAt}, paintedAt: null };
    window.__benchPaint = state;
    const check = () => {
      const transcript = document.querySelector('[data-testid="transcript"]');
      const row = transcript && transcript.querySelector('[data-message-id="' + CSS.escape(target) + '"]');
      if (row) {
        const view = transcript.getBoundingClientRect();
        const box = row.getBoundingClientRect();
        if (box.bottom > view.top && box.top < view.bottom && box.height > 0) {
          requestAnimationFrame(() => { state.paintedAt = performance.now(); });
          return;
        }
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  })();`;
}

async function waitForPaint(page: Page) {
  // A function, not a string: the app's CSP refuses eval.
  await page.waitForFunction(() => (window as BenchWindow).__benchPaint?.paintedAt != null, null, {
    timeout: 60_000,
  });
  return page.evaluate<number>("window.__benchPaint.paintedAt - window.__benchPaint.startedAt");
}

async function heapAndDom(page: Page, session: CDPSession) {
  await session.send("HeapProfiler.collectGarbage");
  const metrics = await cdpMetrics(session);
  const elements = await page.evaluate<number>("document.getElementsByTagName('*').length");
  return { heapMiB: roundMetric((metrics.JSHeapUsedSize ?? 0) / 1024 / 1024), elements };
}

/** A fresh context: no HTTP cache, no code cache, no app query cache. */
async function measureOpenScrollAndStream(bench: Bench, account: Account, thread: BenchThread) {
  const context = await newContext(bench, account.storageState);
  try {
    // Navigation starts the page clock, so painted time is measured from navigation.
    await context.addInitScript(paintWatcher(thread.lastMessageId, "0"));
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    await session.send("Performance.enable");
    await page.goto(`/app/${thread.botId}`, { waitUntil: "commit" });
    const coldOpenMs = await waitForPaint(page);
    await settle(page);
    const opened = await heapAndDom(page, session);

    const olderPages: number[] = [];
    for (;;) {
      const loaded = await page.evaluate<number | null>(LOAD_OLDER_PAGE);
      if (loaded === null) break;
      olderPages.push(loaded);
    }
    await settle(page);
    const allLoaded = await heapAndDom(page, session);

    const scroll = await measureScroll(bench, page, session);
    const stream = await measureStream(bench, account, thread, page, session);
    return {
      coldOpenMs: roundMetric(coldOpenMs),
      ...(olderPages.length ? { olderPageMs: roundedSummary(olderPages).median } : {}),
      heapAfterOpenMiB: opened.heapMiB,
      domNodesAfterOpen: opened.elements,
      heapAllLoadedMiB: allLoaded.heapMiB,
      domNodesAllLoaded: allLoaded.elements,
      ...scroll,
      ...stream,
    };
  } finally {
    await context.close();
  }
}

/** Clicks "Load earlier messages" and times it until the new rows are drawn; null once none are left. */
const LOAD_OLDER_PAGE = `(async () => {
  const button = document.querySelector('[data-testid="transcript"] button[aria-label="Load earlier messages"]');
  if (!button) return null;
  const count = () => document.querySelectorAll('[data-testid="transcript"] [data-message-id]').length;
  const before = count();
  const started = performance.now();
  button.click();
  await new Promise((resolve) => {
    const check = () => {
      if (count() > before) requestAnimationFrame(() => resolve());
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
  return performance.now() - started;
})()`;

async function settle(page: Page) {
  await page.evaluate(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  await page.waitForTimeout(500);
}

/** Scrolls the whole transcript to the top and back at a fixed speed, one step per frame. */
async function measureScroll(bench: Bench, page: Page, session: CDPSession) {
  await page.evaluate(`(() => {
    const transcript = document.querySelector('[data-testid="transcript"]');
    transcript.scrollTop = transcript.scrollHeight;
  })()`);
  await settle(page);
  const before = await cdpMetrics(session);
  const sweep = await page.evaluate<{ frames: number[]; longTasks: number[] }>(`(async () => {
    const transcript = document.querySelector('[data-testid="transcript"]');
    const step = ${bench.scrollStepPx};
    const longTasks = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
    observer.observe({ type: "longtask" });
    const frames = [];
    await new Promise((resolve) => {
      let previous = 0;
      let up = true;
      const tick = (now) => {
        if (previous) frames.push(now - previous);
        previous = now;
        if (up) {
          transcript.scrollTop = Math.max(0, transcript.scrollTop - step);
          if (transcript.scrollTop <= 0) up = false;
        } else {
          const end = transcript.scrollHeight - transcript.clientHeight;
          transcript.scrollTop = Math.min(end, transcript.scrollTop + step);
          if (transcript.scrollTop >= end - 1 || frames.length > 20000) return resolve();
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    observer.disconnect();
    return { frames, longTasks };
  })()`);
  const after = await cdpMetrics(session);
  const frames = roundedSummary(sweep.frames);
  return {
    scrollFrameP50Ms: frames.median,
    scrollFrameP95Ms: frames.p95,
    scrollLongTasks: sweep.longTasks.length,
    scrollLongTaskMs: roundMetric(sweep.longTasks.reduce((total, value) => total + value, 0)),
    scrollLayoutMs: durationDelta(before, after, "LayoutDuration"),
    scrollRecalcStyleMs: durationDelta(before, after, "RecalcStyleDuration"),
    scrollScriptMs: durationDelta(before, after, "ScriptDuration"),
    scrollTaskMs: durationDelta(before, after, "TaskDuration"),
    scrollTaskPerFrameMs: roundMetric(
      durationDelta(before, after, "TaskDuration") / sweep.frames.length,
      3,
    ),
  };
}

/**
 * Streams a long reply into the open chat through the app's own event path: a running run, then
 * `thread.progress` deltas like the executor sends, delivered over the page's live subscription.
 */
async function measureStream(
  bench: Bench,
  account: Account,
  thread: BenchThread,
  page: Page,
  session: CDPSession,
) {
  const { prisma, events } = bench;
  const run = await runAsSystem("benchmark stream", async () => {
    const task = await prisma.task.create({
      data: {
        spaceId: thread.spaceId,
        botId: thread.botId,
        threadId: thread.threadId,
        userId: account.userId,
        prompt: "Benchmark streaming reply",
        status: "running",
      },
    });
    return prisma.run.create({
      data: {
        spaceId: thread.spaceId,
        botId: thread.botId,
        threadId: thread.threadId,
        taskId: task.id,
        userId: account.userId,
        status: "running",
        trigger: "user",
        startedAt: new Date(),
        leaseOwner: "benchmark",
        leaseExpiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
  });
  const target = { spaceId: thread.spaceId, threadId: thread.threadId, botId: thread.botId };
  await events.append({
    ...target,
    type: "run.started",
    runId: run.id,
    payload: { trigger: "user" },
  });
  await settle(page);

  await page.evaluate(`(() => {
    const transcript = document.querySelector('[data-testid="transcript"]');
    const target = ${JSON.stringify(`progress:${run.id}`)};
    const state = { frames: [], longTasks: [], doneAt: null, active: true };
    window.__benchStream = state;
    state.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) state.longTasks.push(entry.duration);
    });
    state.observer.observe({ type: "longtask" });
    let previous = 0;
    const tick = (now) => {
      if (previous) state.frames.push(now - previous);
      previous = now;
      if (state.doneAt === null) {
        const row = transcript.querySelector('[data-message-id="' + CSS.escape(target) + '"]');
        if (row && row.textContent.includes(${JSON.stringify(STREAM_END)})) {
          requestAnimationFrame(() => { state.doneAt = performance.timeOrigin + performance.now(); });
        }
      }
      if (state.active) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
  const before = await cdpMetrics(session);
  const chunks = streamChunks(STREAMED_REPLY, bench.streamUpdates);
  const started = Date.now();
  for (const [index, chunk] of chunks.entries()) {
    await abortableDelay(Math.max(0, started + index * bench.streamIntervalMs - Date.now()));
    await events.append({
      ...target,
      type: "thread.progress",
      runId: run.id,
      // The first update replaces the working line; later ones append, as the executor does.
      payload: index === 0 ? { text: chunk, streaming: true } : { delta: chunk, streaming: true },
    });
  }
  const lastSentAt = Date.now();
  await page.waitForFunction(() => (window as BenchWindow).__benchStream?.doneAt != null, null, {
    timeout: 60_000,
  });
  const after = await cdpMetrics(session);
  const measured = await page.evaluate<{ frames: number[]; longTasks: number[]; doneAt: number }>(
    `(() => {
      const state = window.__benchStream;
      state.active = false;
      state.observer.disconnect();
      return { frames: state.frames, longTasks: state.longTasks, doneAt: state.doneAt };
    })()`,
  );

  await runAsSystem("benchmark stream", () =>
    prisma.run.update({
      where: { id: run.id },
      data: {
        status: "cancelled",
        completedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    }),
  );
  await events.append({ ...target, type: "run.cancelled", runId: run.id, payload: {} });
  await page
    .locator(`[data-message-id="progress:${run.id}"]`)
    .waitFor({ state: "detached", timeout: 10_000 });

  const updates = chunks.length;
  const perUpdate = (name: string) => roundMetric(durationDelta(before, after, name) / updates, 3);
  return {
    streamTaskPerUpdateMs: perUpdate("TaskDuration"),
    streamScriptPerUpdateMs: perUpdate("ScriptDuration"),
    streamLayoutPerUpdateMs: perUpdate("LayoutDuration"),
    streamRecalcStylePerUpdateMs: perUpdate("RecalcStyleDuration"),
    streamFrameP95Ms: roundedSummary(measured.frames).p95,
    streamLongTasks: measured.longTasks.length,
    streamLongTaskMs: roundMetric(measured.longTasks.reduce((total, value) => total + value, 0)),
    streamTailLatencyMs: roundMetric(measured.doneAt - lastSentAt),
  };
}

/**
 * Opens the chat, switches to the home chat, then times the switch back: the app already holds
 * this chat's messages, so this measures rendering, not loading.
 */
async function measureCachedSwitch(bench: Bench, account: Account, thread: BenchThread) {
  const context = await newContext(bench, account.storageState);
  try {
    const page = await context.newPage();
    await page.addInitScript(paintWatcher(thread.lastMessageId, "0"));
    await page.goto(`/app/${thread.botId}`, { waitUntil: "commit" });
    await waitForPaint(page);
    await settle(page);
    await sidebarRow(page, account.homeBotName).click();
    await page.getByRole("combobox", { name: `Message ${account.homeBotName}` }).waitFor();
    await settle(page);
    await sidebarRow(page, thread.name).waitFor();
    // Starting the clock and clicking in one task keeps Playwright's round trips out of it.
    await page.evaluate(`(() => {
      ${paintWatcher(thread.lastMessageId, "performance.now()")}
      const name = ${JSON.stringify(thread.name)};
      const row = [...document.querySelectorAll("aside *")].find(
        (node) => node.childElementCount === 0 && node.textContent.trim() === name,
      );
      row.click();
    })()`);
    return roundMetric(await waitForPaint(page));
  } finally {
    await context.close();
  }
}

function sidebarRow(page: Page, name: string) {
  return page.locator("aside").getByText(name, { exact: true }).first();
}

function durationDelta(
  before: Record<string, number>,
  after: Record<string, number>,
  name: string,
) {
  return roundMetric(((after[name] ?? 0) - (before[name] ?? 0)) * 1000);
}

function summarizeRows(rows: Partial<Record<MetricKey, number>>[]): Summary {
  const summary: Summary = {};
  for (const [key] of METRICS) {
    const values = rows.map((row) => row[key]).filter((value) => typeof value === "number");
    if (values.length) summary[key] = roundedSummary(values);
  }
  return summary;
}

function renderReport(report: WebChatReport) {
  const sizes = Object.keys(report.results);
  const lines = [
    `# Web chat performance: ${report.label}`,
    "",
    `Commit \`${String(report.environment.gitSha).slice(0, 12)}\`, Chromium ${report.environment.chromium}, ${report.environment.cpuModel}. Medians of ${report.fixture.samples} runs.`,
    "",
    `| Metric | ${sizes.map((size) => `${size} msgs`).join(" | ")} |`,
    `| --- | ${sizes.map(() => "---:").join(" | ")} |`,
  ];
  for (const [key, title, unit] of METRICS) {
    const cells = sizes.map((size) =>
      formatValue(report.results[size]?.summary[key]?.median, unit),
    );
    if (cells.every((cell) => cell === "n/a")) continue;
    lines.push(`| ${title} | ${cells.join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}

async function compare(beforePath: string | undefined, afterPath: string | undefined) {
  if (!beforePath || !afterPath) {
    throw new Error("Usage: pnpm perf:web-chat compare <before.json> <after.json>");
  }
  const [before, after] = await Promise.all([readReport(beforePath), readReport(afterPath)]);
  for (const key of ["cpuModel", "cpuCount", "platform", "arch", "viewport"]) {
    if (before.environment[key] !== after.environment[key]) {
      console.warn(`Reports differ in ${key}; deltas mix machine and code changes.`);
    }
  }
  for (const key of ["scrollStepPx", "streamUpdates", "streamIntervalMs"] as const) {
    if (before.fixture[key] !== after.fixture[key]) {
      console.warn(`Reports used different ${key}; those rows are not comparable.`);
    }
  }
  const sizes = Object.keys(before.results).filter((size) => size in after.results);
  const lines = [
    `| Metric | Messages | ${before.label} | ${after.label} | Delta |`,
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const [key, title, unit] of METRICS) {
    for (const size of sizes) {
      const was = before.results[size]?.summary[key]?.median;
      const now = after.results[size]?.summary[key]?.median;
      if (was === undefined || now === undefined) continue;
      const delta = percentageDelta(was, now);
      lines.push(
        `| ${title} | ${size} | ${formatValue(was, unit)} | ${formatValue(now, unit)} | ${delta === null ? "n/a" : `${delta > 0 ? "+" : ""}${roundMetric(delta, 1)}%`} |`,
      );
    }
  }
  console.log(lines.join("\n"));
}

async function readReport(file: string): Promise<WebChatReport> {
  const report = JSON.parse(await readFile(file, "utf8")) as WebChatReport;
  if (report.schemaVersion !== SCHEMA_VERSION || !report.results) {
    throw new Error(`${file} is not a web chat performance report`);
  }
  return report;
}

function formatValue(value: number | undefined, unit: string) {
  if (value === undefined) return "n/a";
  return unit === "count" ? String(Math.round(value)) : `${roundMetric(value, 1)} ${unit}`;
}

if (process.argv[2] === "compare") {
  await compare(process.argv[3], process.argv[4]);
} else {
  await benchmark();
}
