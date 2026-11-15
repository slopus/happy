import type { ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { serve } from "@hono/node-server";
import type { ElectronApplication, Page } from "@playwright/test";
import { _electron as electron, expect } from "@playwright/test";
import type { createApp } from "@rakazo/api/app";
import { abortableDelay } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import type { PrismaClient } from "@rakazo/db";
import { createThreadMessage } from "@rakazo/db";
import type { PerformanceReport } from "../performance-report.js";
import {
  PERFORMANCE_REPORT_SCHEMA_VERSION,
  parseTcpPort,
  roundedSummary,
  roundMetric,
} from "../performance-report.js";
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
  startPreview,
  stopProcess,
  waitForUrl,
} from "./performance-stack.js";
import { startPostgres } from "./postgres.js";

loadRootEnv();

const desktopRoot = path.join(root, "apps/desktop");
const webRoot = path.join(root, "apps/web");
const outputLabel = argument("--label") ?? "baseline";
const launchSamples = positiveInteger(argument("--samples") ?? process.env.PERF_SAMPLES ?? "5");
const skipBuild = process.argv.includes("--skip-build");
const remoteRenderer = process.argv.includes("--remote-renderer");
const disableWarmWindow = process.argv.includes("--disable-warm-window");
const assetDelayMs = nonnegativeInteger(argument("--asset-delay") ?? "0");
const conductorPort = parseTcpPort(process.env.CONDUCTOR_PORT ?? "55400", "CONDUCTOR_PORT");
const webPort = parseTcpPort(process.env.PERF_WEB_PORT ?? String(conductorPort), "PERF_WEB_PORT");
const apiPort = parseTcpPort(
  process.env.PERF_API_PORT ?? String(conductorPort + 1),
  "PERF_API_PORT",
);
if (webPort === apiPort) {
  throw new Error(`PERF_WEB_PORT and PERF_API_PORT must differ; both resolved to ${webPort}`);
}
const webOrigin = `http://127.0.0.1:${webPort}`;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const reportDirectory = path.join(root, ".context/performance");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "rakazo-desktop-performance-"));

const container = await startPostgres();
let preview: ChildProcess | undefined;
let server: ReturnType<typeof serve> | undefined;
let handles: Awaited<ReturnType<typeof createApp>> | undefined;

try {
  const databaseUrl = container.getConnectionUri();
  const benchmarkEnv = performanceEnvironment(databaseUrl);
  Object.assign(process.env, benchmarkEnv);

  if (!skipBuild) buildProductionArtifacts(benchmarkEnv);
  migrateDatabase(benchmarkEnv);

  const { createApp } = await import("@rakazo/api/app");
  handles = await createApp({ databaseUrl, prisma: undefined });
  server = serve({
    fetch: (request) => handles!.app.fetch(request),
    hostname: "127.0.0.1",
    port: apiPort,
  });
  await waitForUrl(`${apiOrigin}/health`);

  preview = startPreview(benchmarkEnv, webPort);
  await waitForUrl(webOrigin);

  const executablePath = await packagedExecutable();
  const benchmark = { executablePath, env: benchmarkEnv };
  const primedProfile = path.join(temporaryRoot, "profile-primed");
  await prepareAuthenticatedProfile(benchmark, primedProfile);
  await seedBenchmarkThread(handles.prisma);

  const coldLaunches = [];
  for (let index = 0; index < launchSamples; index += 1) {
    const profile = path.join(temporaryRoot, `profile-cold-${index}`);
    try {
      await cp(primedProfile, profile, { recursive: true });
      coldLaunches.push(await measureLaunch(benchmark, { profile, clearCache: true }));
    } finally {
      await rm(profile, { force: true, recursive: true });
    }
  }

  const warmProfile = path.join(temporaryRoot, "profile-warm");
  await cp(primedProfile, warmProfile, { recursive: true });
  await primeWarmCache(benchmark, warmProfile);
  const warmLaunches = [];
  for (let index = 0; index < launchSamples; index += 1) {
    warmLaunches.push(await measureLaunch(benchmark, { profile: warmProfile, clearCache: false }));
  }

  const interactive = await launchDesktop(benchmark, { profile: warmProfile, clearCache: false });
  let interactions: Awaited<ReturnType<typeof measureInteractions>>;
  try {
    interactions = await measureInteractions(interactive.app, interactive.page);
  } finally {
    await interactive.app.close();
  }

  const environment = environmentFingerprint(coldLaunches[0]!.main.versions);
  const bundles = await measureBundles();
  const report = {
    schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION,
    label: outputLabel,
    createdAt: new Date().toISOString(),
    environment,
    fixture: {
      backend: "scripted/fake",
      messageCount: 100,
      webOrigin,
      launchSamples,
      cacheColdDefinition: "New copied authenticated profile with HTTP and code caches cleared",
      warmDefinition: "New Electron process reusing the same primed profile and caches",
    },
    launches: { cacheCold: coldLaunches, warm: warmLaunches },
    interactions,
    bundles,
    summary: summarizeReport(coldLaunches, warmLaunches, interactions),
  } satisfies PerformanceReport;

  await mkdir(reportDirectory, { recursive: true });
  const reportPath = path.join(reportDirectory, `${safeName(outputLabel)}.json`);
  const markdownPath = path.join(reportDirectory, `${safeName(outputLabel)}.md`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownPath, renderMarkdown(report));
  console.log(`Performance report: ${reportPath}`);
  console.log(renderMarkdown(report));
} finally {
  if (preview) await stopProcess(preview);
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await handles?.stop().catch(() => undefined);
  await container.stop().catch(() => undefined);
  if (temporaryRoot.startsWith(os.tmpdir())) {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

function performanceEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  return {
    ...benchmarkEnvironment({
      databaseUrl,
      webPort,
      apiPort,
      dataDir: path.join(temporaryRoot, "data"),
    }),
    RAKAZO_DISABLE_BUNDLED_RENDERER: remoteRenderer ? "1" : "0",
    RAKAZO_DISABLE_WARM_WINDOW: disableWarmWindow ? "1" : "0",
    RAKAZO_PERFORMANCE_ASSET_DELAY_MS: String(assetDelayMs),
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  };
}

function buildProductionArtifacts(env: NodeJS.ProcessEnv) {
  run("pnpm", ["--filter", "@rakazo/desktop", "pack:dir"], env);
}

async function packagedExecutable() {
  const out = path.join(desktopRoot, "out");
  const candidates = process.platform === "darwin" ? await findNamed(out, "Rakazo.app") : [];
  if (process.platform === "darwin" && candidates[0]) {
    return path.join(candidates[0], "Contents/MacOS/Rakazo");
  }
  const desktopRequire = createRequire(path.join(desktopRoot, "package.json"));
  return desktopRequire("electron") as string;
}

async function findNamed(directory: string, name: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(directory, entry.name);
    if (entry.name === name) found.push(target);
    else if (entry.isDirectory()) found.push(...(await findNamed(target, name)));
  }
  return found;
}

interface BenchmarkContext {
  executablePath: string;
  env: NodeJS.ProcessEnv;
}

interface DesktopLaunchOptions {
  profile: string;
  clearCache: boolean;
  waitForReady?: boolean;
}

async function prepareAuthenticatedProfile(benchmark: BenchmarkContext, profile: string) {
  const { app, page } = await launchDesktop(benchmark, {
    profile,
    clearCache: false,
    waitForReady: false,
  });
  try {
    const stamp = Date.now();
    await page.goto(`${webOrigin}/sign-up`);
    await page.getByPlaceholder("Your name").fill("Benchmark User");
    await page.getByPlaceholder("Your email address").fill(`benchmark-${stamp}@rakazo.test`);
    await page.getByPlaceholder("Password").fill("password12");
    await page.getByRole("button", { name: "Create account" }).click();
    await page
      .waitForFunction(() => /^\/(?:onboarding|app)/.test(window.location.pathname), undefined, {
        timeout: 10_000,
      })
      .catch(async (error) => {
        const message = await page
          .locator('form p[role="alert"]')
          .textContent()
          .catch(() => null);
        throw new Error(
          `Benchmark sign-up stayed on ${new URL(page.url()).pathname}${message ? `: ${message}` : ""}`,
          { cause: error },
        );
      });
    const connectHeading = page.getByRole("heading", { name: "Connect a model" });
    const composer = page.getByRole("combobox", { name: "Message Chief" });
    await connectHeading.or(composer).waitFor({ timeout: 20_000 });
    if (await connectHeading.isVisible().catch(() => false)) {
      throw new Error(
        "Benchmark sign-up requires a default model; connect-model is unsupported here",
      );
    }
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await waitForShell(page);
  } finally {
    await app.close();
  }
}

async function seedBenchmarkThread(prisma: PrismaClient) {
  const bot = await prisma.bot.findFirst({
    where: { name: "Chief" },
    select: { thread: { select: { id: true } } },
  });
  const threadId = bot?.thread?.id;
  if (!threadId) throw new Error("Benchmark onboarding did not create a thread");
  await prisma.$transaction([
    prisma.message.deleteMany({ where: { threadId } }),
    prisma.thread.update({ where: { id: threadId }, data: { nextMessageSeq: 0 } }),
    // The chat starts read for everyone.
    prisma.threadRead.deleteMany({ where: { threadId } }),
  ]);
  for (let index = 0; index < 100; index += 1) {
    const role = index % 2 === 0 ? "user" : "bot";
    const text =
      role === "user"
        ? `Benchmark request ${index + 1}: summarize the current project state and identify the next concrete action.`
        : [
            `### Benchmark response ${index + 1}`,
            "The current state is healthy. This representative Markdown exercises parsing and layout.",
            "- Preserve existing behavior",
            "- Measure before changing the hot path",
            "- Verify the result with deterministic tests",
            "",
            "`pnpm check && pnpm test`",
          ].join("\n");
    await createThreadMessage(prisma, { threadId, role, blocks: [{ kind: "text", text }] });
  }
}

async function primeWarmCache(benchmark: BenchmarkContext, profile: string) {
  const launched = await launchDesktop(benchmark, { profile, clearCache: false });
  await launched.app.close();
}

async function measureLaunch(
  benchmark: BenchmarkContext,
  options: Pick<DesktopLaunchOptions, "profile" | "clearCache">,
) {
  const launched = await launchDesktop(benchmark, options);
  try {
    return await collectLaunchRecord(launched);
  } finally {
    await launched.app.close();
  }
}

async function launchDesktop(
  benchmark: BenchmarkContext,
  { profile, clearCache, waitForReady = true }: DesktopLaunchOptions,
) {
  const launchEpochMs = Date.now();
  const launchClockMs = performance.now();
  const app = await electron.launch({
    executablePath: benchmark.executablePath,
    env: {
      ...benchmark.env,
      RAKAZO_PERFORMANCE_USER_DATA: profile,
      RAKAZO_PERFORMANCE_CLEAR_CACHE: clearCache ? "1" : "0",
    },
  });
  const page = await app.firstWindow();
  const firstWindowMs = performance.now() - launchClockMs;
  if (waitForReady) await waitForShell(page);
  return { app, page, launchEpochMs, firstWindowMs };
}

async function waitForShell(page: Page) {
  await page.locator('[data-testid="shell-root"][data-ready="true"]').waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => {
    const transcript = document.querySelector<HTMLElement>('[data-testid="transcript"]');
    if (!transcript) return false;
    return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 1;
  });
  await page.waitForFunction(
    () => performance.getEntriesByName("rk:renderer:shell-painted").length === 1,
    undefined,
    { timeout: 30_000 },
  );
}

async function collectLaunchRecord(launched: Awaited<ReturnType<typeof launchDesktop>>) {
  const renderer = await launched.page.evaluate(() => {
    const entries = performance.getEntries();
    const marks = entries
      .filter((entry) => entry.entryType === "mark")
      .map((entry) => ({
        name: entry.name,
        startTime: entry.startTime,
      }));
    const paints = entries
      .filter((entry) => String(entry.entryType) === "paint")
      .map((entry) => ({
        name: entry.name,
        startTime: entry.startTime,
      }));
    const navigation = entries.find((entry) => String(entry.entryType) === "navigation") as
      | PerformanceNavigationTiming
      | undefined;
    return {
      timeOrigin: performance.timeOrigin,
      marks,
      paints,
      navigation: navigation
        ? {
            domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
            loadEventEnd: navigation.loadEventEnd,
            responseEnd: navigation.responseEnd,
          }
        : null,
    };
  });
  const main = await launched.app.evaluate(() => ({
    timeOrigin: performance.timeOrigin,
    marks: performance.getEntriesByType("mark").map((entry) => ({
      name: entry.name,
      startTime: entry.startTime,
    })),
    versions: process.versions,
  }));
  const shellPainted = renderer.marks.find((mark) => mark.name === "rk:renderer:shell-painted");
  if (!shellPainted) throw new Error("Renderer did not record shell-painted");
  return {
    firstWindowMs: roundMetric(launched.firstWindowMs),
    shellUsableMs: roundMetric(
      renderer.timeOrigin + shellPainted.startTime - launched.launchEpochMs,
    ),
    main,
    renderer,
  };
}

async function measureInteractions(app: ElectronApplication, page: Page) {
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  const settingsBefore = await cdpMetrics(session);
  const settings = await page.evaluate(async () => {
    const button = document.querySelector<HTMLButtonElement>(
      '[data-testid="bot-settings-trigger"]',
    );
    const panel = document.querySelector<HTMLElement>('[data-testid="side-panel"]');
    if (!button || !panel) throw new Error("Settings benchmark controls are missing");
    const durationMs = maximumTransitionMs(getComputedStyle(panel));
    const transition = new Promise<void>((resolve) => {
      if (durationMs === 0) return resolve();
      const controller = new AbortController();
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        controller.abort();
        resolve();
      }, durationMs + 100);
      panel.addEventListener(
        "transitionend",
        (event) => {
          if (event.target !== panel || settled) return;
          settled = true;
          window.clearTimeout(timeout);
          controller.abort();
          resolve();
        },
        { signal: controller.signal },
      );
    });
    const committed = new Promise<number>((resolve) => {
      const observer = new MutationObserver(() => {
        if (!panel.querySelector('[data-testid="bot-settings"]')) return;
        observer.disconnect();
        resolve(performance.now());
      });
      observer.observe(panel, { childList: true, subtree: true });
      if (panel.querySelector('[data-testid="bot-settings"]')) {
        observer.disconnect();
        resolve(performance.now());
      }
    });
    const started = performance.now();
    button.click();
    const committedAt = await committed;
    await nextPaint();
    const paintedAt = performance.now();
    await transition;
    await nextPaint();
    return {
      commitMs: committedAt - started,
      paintedMs: paintedAt - started,
      settledMs: performance.now() - started,
    };

    function maximumTransitionMs(style: CSSStyleDeclaration) {
      const durations = style.transitionDuration.split(",").map(milliseconds);
      const delays = style.transitionDelay.split(",").map(milliseconds);
      return Math.max(0, ...durations.map((duration, index) => duration + (delays[index] ?? 0)));
    }

    function milliseconds(value: string) {
      const trimmed = value.trim();
      return trimmed.endsWith("ms")
        ? Number.parseFloat(trimmed)
        : Number.parseFloat(trimmed) * 1000;
    }

    function nextPaint() {
      return new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    }
  });
  const settingsAfter = await cdpMetrics(session);
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await page.locator('[data-testid="side-panel"][data-panel="closed"]').waitFor();
  await page.waitForTimeout(200);

  const typingBefore = await cdpMetrics(session);
  const composer = page.getByPlaceholder(/Message Chief/);
  await composer.fill("");
  await composer.focus();
  const characterCount = 40;
  await page.evaluate(() => {
    const target = document.querySelector<HTMLInputElement>('input[placeholder^="Message "]');
    if (!target) throw new Error("Composer is missing");
    const samples: number[] = [];
    (window as typeof window & { __rakazoKeyPaintSamples?: number[] }).__rakazoKeyPaintSamples =
      samples;
    target.addEventListener("keydown", () => {
      const started = performance.now();
      requestAnimationFrame(() => samples.push(performance.now() - started));
    });
  });
  await page.keyboard.type("a".repeat(characterCount), { delay: 16 });
  await page.waitForFunction(
    (count) =>
      ((window as typeof window & { __rakazoKeyPaintSamples?: number[] }).__rakazoKeyPaintSamples
        ?.length ?? 0) >= count,
    characterCount,
  );
  const keyPaintMs = await page.evaluate(
    () =>
      (window as typeof window & { __rakazoKeyPaintSamples?: number[] }).__rakazoKeyPaintSamples ??
      [],
  );
  const typingAfter = await cdpMetrics(session);

  const idleRequests = new Map<string, number>();
  const onRequest = (request: { url(): string }) => {
    const url = new URL(request.url());
    if (url.origin !== webOrigin) return;
    idleRequests.set(url.pathname, (idleRequests.get(url.pathname) ?? 0) + 1);
  };
  page.on("request", onRequest);
  const idle = await sampleAppMetrics(app, 12_000, 1_000);
  page.off("request", onRequest);

  await composer.fill("keep working until I stop you");
  // Pass a string so tsx/esbuild does not inject its `__name` helper into code
  // that Playwright serializes into the renderer's isolated execution context.
  const streamFrames = page.evaluate<number[]>(`new Promise((resolve) => {
    const intervals = [];
    let previous = performance.now();
    let active = true;
    function tick(now) {
      intervals.push(now - previous);
      previous = now;
      if (active) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    window.setTimeout(() => {
      active = false;
      resolve(intervals);
    }, 5000);
  })`);
  const streamingMetrics = sampleAppMetrics(app, 5_000, 500);
  await page.keyboard.press("Enter");
  await page.getByText("still working…").first().waitFor({ timeout: 10_000 });
  const [streamFrameIntervalsMs, streaming] = await Promise.all([streamFrames, streamingMetrics]);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: "Send" }).waitFor();

  await session.detach();
  const reopen = process.platform === "darwin" ? await measureReopen(app, page) : null;
  return {
    settings: {
      commitMs: roundMetric(settings.commitMs),
      paintedMs: roundMetric(settings.paintedMs),
      settledMs: roundMetric(settings.settledMs),
      cdpDelta: metricDelta(settingsBefore, settingsAfter),
    },
    typing: {
      keyPaintMs: keyPaintMs.map((value) => roundMetric(value)),
      summary: roundedSummary(keyPaintMs),
      cdpDelta: metricDelta(typingBefore, typingAfter),
    },
    idle: {
      durationMs: 12_000,
      requests: Object.fromEntries([...idleRequests.entries()].sort()),
      metrics: idle,
      summary: summarizeProcessSamples(idle),
    },
    streaming: {
      durationMs: 5_000,
      frameIntervalsMs: streamFrameIntervalsMs.map((value) => roundMetric(value)),
      framesOver32Ms: streamFrameIntervalsMs.filter((value) => value > 32).length,
      frameSummary: roundedSummary(streamFrameIntervalsMs),
      metrics: streaming,
      summary: summarizeProcessSamples(streaming),
    },
    reopen,
  };
}

async function measureReopen(app: ElectronApplication, page: Page) {
  const rendererPidBefore = await app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.mainFrame.osProcessId,
  );
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  const closedState = await waitForWindowHiddenOrClosed(app);
  const hidden = await sampleAppMetrics(app, 1_000, 1_000);
  const newWindow = closedState.count === 0 ? app.waitForEvent("window") : null;
  const started = performance.now();
  await app.evaluate(({ app }) => app.emit("activate"));
  const reopenedPage = newWindow ? await newWindow : page;
  if (newWindow) await waitForShell(reopenedPage);
  await waitForWindowVisible(app);
  await reopenedPage.evaluate<number>(`new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())));
  })`);
  const reopenMs = performance.now() - started;
  const rendererPidAfter = await app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.mainFrame.osProcessId,
  );
  return {
    reopenMs: roundMetric(reopenMs),
    retainedRenderer: rendererPidBefore === rendererPidAfter,
    hidden: summarizeProcessSamples(hidden),
  };
}

async function waitForWindowHiddenOrClosed(app: ElectronApplication) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await app.evaluate(({ BrowserWindow }) => ({
      count: BrowserWindow.getAllWindows().length,
      visible: BrowserWindow.getAllWindows()[0]?.isVisible() ?? false,
    }));
    if (state.count === 0 || !state.visible) return state;
    await abortableDelay(20);
  }
  throw new Error("Desktop window did not hide or close");
}

async function waitForWindowVisible(app: ElectronApplication) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const visible = await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false,
    );
    if (visible) return;
    await abortableDelay(20);
  }
  throw new Error("Desktop window did not become visible");
}

function metricDelta(before: Record<string, number>, after: Record<string, number>) {
  return Object.fromEntries(
    ["LayoutCount", "LayoutDuration", "RecalcStyleCount", "RecalcStyleDuration", "TaskDuration"]
      .filter((name) => before[name] !== undefined && after[name] !== undefined)
      .map((name) => [name, roundMetric(after[name]! - before[name]!, 5)]),
  );
}

async function sampleAppMetrics(app: ElectronApplication, durationMs: number, intervalMs: number) {
  return app.evaluate(
    async ({ app, BrowserWindow }, options) => {
      app.getAppMetrics();
      const rendererPid = BrowserWindow.getAllWindows()[0]?.webContents.mainFrame.osProcessId;
      const samples = [];
      const count = Math.ceil(options.durationMs / options.intervalMs);
      for (let index = 0; index < count; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
        samples.push({
          at: performance.timeOrigin + performance.now(),
          processes: app.getAppMetrics().map((metric) => ({
            pid: metric.pid,
            creationTime: metric.creationTime,
            type: metric.type,
            serviceName: metric.serviceName,
            name: metric.name,
            renderer: metric.pid === rendererPid,
            cpu: metric.cpu.percentCPUUsage,
            idleWakeups: metric.cpu.idleWakeupsPerSecond,
            memory: metric.memory,
          })),
        });
      }
      return samples;
    },
    { durationMs, intervalMs },
  );
}

function summarizeProcessSamples(samples: Awaited<ReturnType<typeof sampleAppMetrics>>) {
  const cpu = samples.map((sample) =>
    sample.processes.reduce((total, process) => total + process.cpu, 0),
  );
  const workingSet = samples.map((sample) =>
    sample.processes.reduce((total, process) => total + workingSetKiB(process.memory), 0),
  );
  const rendererWorkingSet = samples.map((sample) =>
    sample.processes
      .filter((process) => process.renderer)
      .reduce((total, process) => total + workingSetKiB(process.memory), 0),
  );
  return {
    cpuPercent: roundedSummary(cpu),
    summedWorkingSetKiB: roundedSummary(workingSet),
    rendererWorkingSetKiB: roundedSummary(rendererWorkingSet),
  };
}

function workingSetKiB(memory: object) {
  const value = (memory as { workingSetSize?: unknown }).workingSetSize;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Electron app metrics did not include a valid workingSetSize");
  }
  return value;
}

function environmentFingerprint(versions: { electron?: string; chrome?: string }) {
  return {
    gitSha: output("git", ["rev-parse", "HEAD"]),
    gitDirty: output("git", ["status", "--porcelain"]).length > 0,
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    node: process.version,
    electron: versions.electron,
    chrome: versions.chrome,
    playwright: createRequire(import.meta.url)("@playwright/test/package.json").version,
    buildMode: "production-vite-preview+electron-builder-dir",
    rendererMode: remoteRenderer ? "remote" : "bundled",
    warmWindow: disableWarmWindow ? "disabled" : "enabled",
    assetDelayMs,
  };
}

async function measureBundles() {
  const web = await directorySize(path.join(webRoot, "dist"));
  const applications = await findNamed(path.join(desktopRoot, "out"), "Rakazo.app");
  const desktop = applications[0] ? await directorySize(applications[0]) : null;
  return { web, desktop };
}

async function directorySize(directory: string) {
  let rawBytes = 0;
  let gzipBytes = 0;
  let brotliBytes = 0;
  let fileCount = 0;
  for (const file of await filesUnder(directory)) {
    rawBytes += (await stat(file)).size;
    fileCount += 1;
    if (/\.(?:css|html|js|json|svg)$/.test(file)) {
      const content = await readFile(file);
      gzipBytes += gzipSync(content).byteLength;
      brotliBytes += brotliCompressSync(content).byteLength;
    }
  }
  return { fileCount, rawBytes, gzipBytes, brotliBytes };
}

async function filesUnder(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(target)));
    else if ((await stat(target)).isFile()) files.push(target);
  }
  return files;
}

function summarizeReport(
  cold: Array<{ shellUsableMs: number }>,
  warm: Array<{ shellUsableMs: number }>,
  interactions: Awaited<ReturnType<typeof measureInteractions>>,
) {
  return {
    cacheColdShellUsableMs: roundedSummary(cold.map((sample) => sample.shellUsableMs)),
    warmShellUsableMs: roundedSummary(warm.map((sample) => sample.shellUsableMs)),
    settingsPaintedMs: interactions.settings.paintedMs,
    settingsSettledMs: interactions.settings.settledMs,
    typingKeyPaintMs: interactions.typing.summary,
    idleCpuPercent: interactions.idle.summary.cpuPercent,
    idleSummedWorkingSetKiB: interactions.idle.summary.summedWorkingSetKiB,
    streamingCpuPercent: interactions.streaming.summary.cpuPercent,
    reopenMs: interactions.reopen?.reopenMs ?? null,
    hiddenSummedWorkingSetKiB: interactions.reopen?.hidden.summedWorkingSetKiB.median ?? null,
  };
}

function renderMarkdown(report: PerformanceReport) {
  const summary = report.summary;
  return `# Rakazo desktop performance — ${report.label}

- Commit: \`${report.environment.gitSha.slice(0, 12)}\`
- Platform: ${report.environment.platform}/${report.environment.arch}
- Electron: ${report.environment.electron ?? "unknown"}
- Renderer: ${report.environment.rendererMode} (${report.environment.assetDelayMs ?? 0} ms asset delay)
- Warm window: ${report.environment.warmWindow}

| Metric | Median | p95 |
| --- | ---: | ---: |
| Cache-cold shell usable | ${summary.cacheColdShellUsableMs.median} ms | ${summary.cacheColdShellUsableMs.p95} ms |
| Warm shell usable | ${summary.warmShellUsableMs.median} ms | ${summary.warmShellUsableMs.p95} ms |
| Keydown to frame | ${summary.typingKeyPaintMs.median} ms | ${summary.typingKeyPaintMs.p95} ms |
| Idle total CPU | ${summary.idleCpuPercent.median}% | ${summary.idleCpuPercent.p95}% |
| Idle summed working set | ${bytesToMib(summary.idleSummedWorkingSetKiB.median * 1024)} MiB | ${bytesToMib(summary.idleSummedWorkingSetKiB.p95 * 1024)} MiB |

- Settings: ${summary.settingsPaintedMs} ms to painted, ${summary.settingsSettledMs} ms settled.
- Reopen: ${summary.reopenMs === null ? "not measured" : `${summary.reopenMs} ms`}; hidden app summed working set: ${summary.hiddenSummedWorkingSetKiB === null ? "not measured" : `${bytesToMib(summary.hiddenSummedWorkingSetKiB * 1024)} MiB`}.
- Web bundle: ${bytesToMib(report.bundles.web.rawBytes)} MiB raw.
- Desktop app: ${report.bundles.desktop ? `${bytesToMib(report.bundles.desktop.rawBytes)} MiB` : "not available"}.
`;
}

function bytesToMib(value: number) {
  return roundMetric(value / 1024 / 1024);
}

function nonnegativeInteger(value: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`Expected a non-negative integer: ${value}`);
  return parsed;
}
