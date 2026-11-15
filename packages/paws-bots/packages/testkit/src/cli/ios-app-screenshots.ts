import { execFile, spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadIosScreenshotCatalog } from "../ios-screenshot-catalog.js";
import type { IosGallerySection } from "../ios-screenshot-gallery.js";
import { renderIosScreenshotGallery } from "../ios-screenshot-gallery.js";
import { startIosScreenshotBackend } from "./ios-screenshot-backend.js";
import { captureIosProviderLimitError } from "./ios-screenshot-error.js";
import { assertPublishConfigured, publishIosGallery } from "./ios-screenshot-publish.js";
import { seedIosScreenshotFixture } from "./ios-screenshot-seed.js";
import { runProcess } from "./process.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const CATALOG_DIR = path.join(ROOT, "apps", "mobile", "e2e", "ios-screenshots");

interface SectionResult {
  id: string;
  title: string;
  ok: boolean;
  screenshots: string[];
  error?: string;
}

const LOCAL_API_PORT = 3110;
// Debug builds load JavaScript from this port only.
const METRO_PORT = 8081;
const METRO_URL = `http://localhost:${METRO_PORT}`;
// The local API names this as the web origin, which computer screens load through, as in production.
const SCREEN_RELAY_PORT = 5180;
const LOCAL_PASSWORD = "ios-screenshot-password-1234";

async function main() {
  const { sections: requested, publish } = parseArgs(process.argv.slice(2));
  if (publish) {
    // A partial run keeps older shots of the other sections, which must not go out as this run's.
    if (requested.length > 0) throw new Error("--publish needs a full run, without --section");
    assertPublishConfigured();
  }
  const catalog = await loadIosScreenshotCatalog(CATALOG_DIR);
  const unknown = requested.filter((id) => !catalog.some((section) => section.id === id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown section ${unknown.join(", ")}. Choose from: ${catalog.map((section) => section.id).join(", ")}`,
    );
  }
  const sections = requested.length
    ? catalog.filter((section) => requested.includes(section.id))
    : catalog;

  const serverUrl = requiredEnv("DATABASE_URL");
  // The seeder writes encrypted messages, so it shares the local API's keys.
  process.env.BETTER_AUTH_SECRET = "ios-screenshot-auth-secret-32-chars";
  process.env.ENCRYPTION_KEY = "ios-screenshot-encryption-key-32-chars";
  process.env.SCREEN_PROXY_SECRET = "ios-screenshot-screen-secret-32-chars";
  const email = "ios-screenshots@example.test";
  const emptyEmail = "ios-screenshots-empty@example.test";
  const freeEmail = "ios-screenshots-free@example.test";
  const password = LOCAL_PASSWORD;
  const outDir = path.resolve(
    process.env.IOS_SCREENSHOT_OUT || path.join(ROOT, "test-report", "ios-screenshots"),
  );

  await assertSafeOutputDirectory(outDir);
  const udid = await simulatorUdid();
  if (requested.length === 0) await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const backend = await startIosScreenshotBackend({
    root: ROOT,
    serverUrl,
    port: LOCAL_API_PORT,
    dataDir: path.join(ROOT, ".tmp", "ios-screenshots-data"),
  });
  const { apiUrl, databaseUrl } = backend;
  const metro = await startMetro(apiUrl, outDir);
  const screenRelay = await startScreenRelay(apiUrl, outDir).catch(async (error: unknown) => {
    metro.stop();
    await backend.stop();
    throw error;
  });
  try {
    await firstLaunch(udid, outDir);
    const fixture = await seedIosScreenshotFixture({
      apiUrl,
      databaseUrl,
      email,
      emptyEmail,
      freeEmail,
      password,
      completeCheckout: backend.completeCheckout,
    });
    await captureSections({
      sections,
      udid,
      outDir,
      databaseUrl,
      env: {
        RAKAZO_SCREENSHOT_EMAIL: email,
        RAKAZO_SCREENSHOT_EMPTY_EMAIL: emptyEmail,
        RAKAZO_SCREENSHOT_FREE_EMAIL: freeEmail,
        RAKAZO_SCREENSHOT_PASSWORD: password,
        RAKAZO_SCREENSHOT_BOT_ID: fixture.botId,
        RAKAZO_SCREENSHOT_PEER_BOT_ID: fixture.peerBotId,
        RAKAZO_SCREENSHOT_GROUP_ID: fixture.groupId,
        RAKAZO_SCREENSHOT_ROUTINE_ID: fixture.routineId,
        RAKAZO_SCREENSHOT_ARTIFACT_ID: fixture.artifactId,
        RAKAZO_SCREENSHOT_MARKDOWN_ID: fixture.markdownId,
        RAKAZO_SCREENSHOT_IMAGE_ID: fixture.imageId,
        RAKAZO_SCREENSHOT_PDF_ID: fixture.pdfId,
        RAKAZO_SCREENSHOT_ARCHIVE_ID: fixture.archiveId,
        RAKAZO_SCREENSHOT_VIDEO_ID: fixture.videoId,
        RAKAZO_SCREENSHOT_TEAM_SPACE_ID: fixture.teamSpaceId,
        RAKAZO_SCREENSHOT_CONVERSATION_ID: fixture.conversationId,
        RAKAZO_SCREENSHOT_CARDS_BOT_ID: fixture.cardsBotId,
      },
      botId: fixture.botId,
    });
  } finally {
    screenRelay.stop();
    metro.stop();
    await backend.stop();
  }
  if (publish) console.log(`Published: ${await publishIosGallery(outDir, ROOT)}`);
}

async function captureSections(input: {
  sections: Awaited<ReturnType<typeof loadIosScreenshotCatalog>>;
  udid: string;
  outDir: string;
  databaseUrl: string;
  env: Record<string, string>;
  botId: string;
}) {
  const { sections, udid, outDir, databaseUrl, env, botId } = input;
  const catalog = await loadIosScreenshotCatalog(CATALOG_DIR);
  const results: SectionResult[] = [];
  for (const section of sections) {
    const work = path.join(outDir, ".maestro", section.id);
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    const capture = () =>
      runProcess(
        "maestro",
        [
          "--udid",
          udid,
          "test",
          "--no-ansi",
          "--flatten-debug-output",
          "--debug-output",
          path.join(work, "debug"),
          "--test-output-dir",
          path.join(work, "out"),
          ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
          path.join(CATALOG_DIR, section.flow),
        ],
        process.env,
      );
    try {
      if (section.id === "thread-errors") {
        await captureIosProviderLimitError(databaseUrl, botId, capture);
      } else {
        await capture();
      }
      results.push({
        id: section.id,
        title: section.title,
        ok: true,
        screenshots: await publishShots(work, path.join(outDir, section.id)),
      });
    } catch (_error) {
      results.push({
        id: section.id,
        title: section.title,
        ok: false,
        screenshots: await publishShots(work, path.join(outDir, section.id)).catch(() => []),
        error: await describeFailure(work),
      });
    }
  }

  const gallery = await galleryFromDisk(outDir, catalog);
  await writeFile(path.join(outDir, "index.html"), renderIosScreenshotGallery(gallery));
  await writeFile(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify(
      results.map(({ id, title, ok, screenshots, error }) => ({
        id,
        title,
        ok,
        count: screenshots.length,
        screenshots,
        ...(error ? { error } : {}),
      })),
      null,
      2,
    )}\n`,
  );

  for (const result of results) {
    const status = result.ok ? "ok" : "failed";
    console.log(`${result.id}\t${status}\t${result.screenshots.length}`);
    if (result.error) console.log(`  ${result.error.replaceAll("\n", "\n  ")}`);
  }
  console.log(`Gallery: ${path.join(outDir, "index.html")}`);
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

/** The failing Maestro step and the last screen it saw, so a failure needs no log digging. */
async function describeFailure(work: string) {
  let step = "";
  let screen = "";
  await walk(work, async (file) => {
    const name = path.basename(file);
    if (name === "commands.json") {
      // A crashed run can leave this file cut short; the screenshot still helps.
      const commands = (await readFile(file, "utf8")
        .then(JSON.parse)
        .catch(() => [])) as {
        command: Record<string, unknown>;
        metadata?: { status?: string; error?: { message?: string } };
      }[];
      const failed = commands.find((entry) => entry.metadata?.status === "FAILED");
      if (failed) step = `${Object.keys(failed.command)[0]}: ${failed.metadata?.error?.message}`;
    } else if (name.startsWith("step-") && name.endsWith(".png") && file > screen) {
      screen = file;
    }
  });
  return [step || "flow failed", screen && `last screen: ${screen}`].filter(Boolean).join("\n");
}

/** SIM_UDID, or the only booted simulator. */
async function simulatorUdid() {
  const output = await promisify(execFile)("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
  const booted = Object.values(
    (JSON.parse(output.stdout) as { devices: Record<string, { udid: string; name: string }[]> })
      .devices,
  ).flat();
  const requested = process.env.SIM_UDID?.trim();
  if (requested) {
    if (!booted.some((device) => device.udid === requested)) {
      throw new Error("SIM_UDID is not booted. Boot it with `xcrun simctl boot <udid>` first.");
    }
    return requested;
  }
  if (booted.length === 1 && booted[0]) return booted[0].udid;
  throw new Error(
    booted.length === 0
      ? "Boot an iPhone simulator with the Rakazo app installed, or set SIM_UDID."
      : `Several simulators are booted; set SIM_UDID to one of: ${booted.map((device) => `${device.name} ${device.udid}`).join(", ")}`,
  );
}

/**
 * A debug build loads JavaScript from Metro, and Metro bakes the API address into the bundle.
 * A fresh Metro per run serves exactly the code on disk.
 */
function startMetro(apiUrl: string, outDir: string) {
  return startServer({
    name: "Metro",
    args: [
      "--filter",
      "@rakazo/mobile",
      "exec",
      "expo",
      "start",
      "--dev-client",
      "--port",
      String(METRO_PORT),
      "--localhost",
    ],
    port: METRO_PORT,
    log: path.join(outDir, "metro.log"),
    env: { EXPO_PUBLIC_API_URL: apiUrl, EXPO_NO_TELEMETRY: "1", CI: "1" },
    ready: () =>
      fetch(`${METRO_URL}/status`).then(
        async (response) => (await response.text()).includes("packager-status:running"),
        () => false,
      ),
  });
}

/** The web dev server relays computer screens, as it does for the web app. */
function startScreenRelay(apiUrl: string, outDir: string) {
  return startServer({
    name: "The screen relay",
    args: ["--filter", "@rakazo/web", "exec", "vite"],
    port: SCREEN_RELAY_PORT,
    log: path.join(outDir, "screen-relay.log"),
    // These win over any values in the repository's .env.
    env: {
      API_PROXY_TARGET: apiUrl,
      WEB_PORT: String(SCREEN_RELAY_PORT),
      RAKAZO_DEV_HOST: "127.0.0.1",
      SCREEN_PROXY_SECRET: process.env.SCREEN_PROXY_SECRET ?? "",
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "",
    },
    ready: () =>
      fetch(`http://127.0.0.1:${SCREEN_RELAY_PORT}/`).then(
        (response) => response.ok,
        () => false,
      ),
  });
}

// Ctrl-C reaches only this process's group, so stop every server's group before exiting.
const running = new Set<() => void>();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const stop of running) stop();
    process.exit(130);
  });
}

/**
 * A dev server in its own process group, so stopping it also stops what pnpm starts. It must
 * be fresh: one already on the port could serve other code.
 */
async function startServer(input: {
  name: string;
  args: string[];
  port: number;
  log: string;
  env: Record<string, string>;
  ready: () => Promise<boolean>;
}): Promise<{ stop: () => void }> {
  if (await input.ready()) {
    throw new Error(`${input.name} is already running on port ${input.port}. Stop it first.`);
  }
  const log = createWriteStream(input.log);
  const child = spawn("pnpm", input.args, {
    cwd: ROOT,
    // The local API sets NODE_ENV=test in this process; dev servers must not run as tests.
    env: { ...process.env, NODE_ENV: "development", ...input.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const stop = () => {
    running.delete(stop);
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  };
  running.add(stop);
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await input.ready()) return { stop };
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  stop();
  throw new Error(`${input.name} did not start; see ${input.log}`);
}

/** Launches the app and waits for its first bundle, which can take minutes to build. */
async function firstLaunch(udid: string, outDir: string) {
  await runProcess(
    "maestro",
    [
      "--udid",
      udid,
      "test",
      "--no-ansi",
      "--debug-output",
      path.join(outDir, ".maestro", "first-launch"),
      path.join(CATALOG_DIR, "subflows", "first-launch.yaml"),
    ],
    process.env,
  );
}

function parseArgs(argv: string[]) {
  const sections: string[] = [];
  let publish = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg || arg === "--") continue;
    if (arg === "--section") {
      const value = argv[index + 1];
      if (!value) throw new Error("--section needs a name");
      sections.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--section=")) {
      sections.push(arg.slice("--section=".length));
      continue;
    }
    if (arg === "--publish") {
      publish = true;
      continue;
    }
    throw new Error(`Unknown argument ${arg}`);
  }
  return { sections, publish };
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function resolveOutputPath(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.join(await resolveOutputPath(path.dirname(dir)), path.basename(dir));
  }
}

async function assertSafeOutputDirectory(outDir: string) {
  const resolved = await resolveOutputPath(outDir);
  const repo = await realpath(ROOT);
  const home = await realpath(homedir());
  const relative = path.relative(resolved, repo);
  if (
    resolved === path.parse(resolved).root ||
    resolved === home ||
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  ) {
    throw new Error(
      "IOS_SCREENSHOT_OUT must not be a filesystem root, home, repository, or repository parent",
    );
  }
}

async function publishShots(work: string, dest: string) {
  const found = new Map<string, string>();
  await walk(work, async (file) => {
    const name = path.basename(file);
    if (!/^\d{2}-[a-z0-9-]+\.png$/i.test(name)) return;
    found.set(name, file);
  });
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  const names = [...found.keys()].sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    const source = found.get(name);
    if (source) await copyFile(source, path.join(dest, name));
  }
  return names;
}

async function walk(dir: string, visit: (file: string) => Promise<void>) {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, visit);
    else if (entry.isFile()) await visit(full);
  }
}

async function galleryFromDisk(
  outDir: string,
  catalog: Awaited<ReturnType<typeof loadIosScreenshotCatalog>>,
): Promise<IosGallerySection[]> {
  const sections: IosGallerySection[] = [];
  for (const section of catalog) {
    let names: string[] = [];
    try {
      names = (await readdir(path.join(outDir, section.id)))
        .filter((name) => name.toLowerCase().endsWith(".png"))
        .sort((left, right) => left.localeCompare(right));
    } catch {
      names = [];
    }
    sections.push({
      id: section.id,
      title: section.title,
      shots: names.map((name) => ({ name, src: `${section.id}/${name}` })),
    });
  }
  return sections;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
