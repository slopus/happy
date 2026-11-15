import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlaywrightScreenshot } from "../playwright-report-dashboard.js";
import {
  classifyPlaywrightScreenshot,
  compareScreenshotsWithBaseline,
  createScreenshotManifest,
  renderPlaywrightDashboard,
  renderScreenshotGallery,
  screenshotTitleFromFileName,
  shouldPublishStableMainBaseline,
  updatePlaywrightHistory,
  validatePlaywrightScreenshotBudget,
} from "../playwright-report-dashboard.js";
import { MAX_PNG_SCREENSHOT_BYTES, validatePngScreenshot } from "../png-validation.js";

const [historyPath, dashboardPath, testResultsPath, galleryPath, baselineManifestPath] =
  process.argv.slice(2);
const MAX_ARTIFACT_ENTRIES = 2_000;
const MAX_ARTIFACT_DEPTH = 12;

if (!historyPath || !dashboardPath || !testResultsPath || !galleryPath) {
  throw new Error(
    "Usage: generate-playwright-report-dashboard <history-path> <dashboard-path> <test-results-path> <gallery-path>",
  );
}

const collectedScreenshots = await collectScreenshots(testResultsPath, galleryPath);
const comparison = compareScreenshotsWithBaseline(
  collectedScreenshots,
  await readOptionalJson(baselineManifestPath),
);
const screenshots = comparison.screenshots;
const createdAt = new Date().toISOString();
const dashboardUrl = getRequiredEnvironmentVariable("PLAYWRIGHT_DASHBOARD_URL");
const reportUrl = getOptionalHttpsEnvironmentVariable("PLAYWRIGHT_REPORT_URL");
const screenshotsUrl = getRequiredEnvironmentVariable("PLAYWRIGHT_SCREENSHOTS_URL");
const result = getRequiredEnvironmentVariable("PLAYWRIGHT_RESULT");
const runUrl = getRequiredEnvironmentVariable("PLAYWRIGHT_RUN_URL");
const sha = getRequiredEnvironmentVariable("PLAYWRIGHT_SHA");
const pullRequestNumber = getOptionalNumber("PLAYWRIGHT_PR_NUMBER");
const pullRequestUrl = getOptionalHttpsEnvironmentVariable("PLAYWRIGHT_PR_URL");
const existingHistory = await readHistory(historyPath);
const runIdentity = {
  attempt: getRequiredNumber("PLAYWRIGHT_RUN_ATTEMPT"),
  id: getRequiredEnvironmentVariable("PLAYWRIGHT_RUN_ID"),
};
const history = updatePlaywrightHistory(existingHistory, {
  ...runIdentity,
  branch: getRequiredEnvironmentVariable("PLAYWRIGHT_BRANCH"),
  createdAt,
  event: getRequiredEnvironmentVariable("PLAYWRIGHT_EVENT"),
  pullRequestNumber,
  pullRequestUrl,
  reportUrl,
  result,
  runNumber: getRequiredNumber("PLAYWRIGHT_RUN_NUMBER"),
  runUrl,
  screenshotCount: screenshots.length,
  screenshotsUrl,
  sha,
});

await mkdir(path.dirname(historyPath), { recursive: true });
await mkdir(path.dirname(dashboardPath), { recursive: true });
await mkdir(galleryPath, { recursive: true });
await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`);
await writeFile(dashboardPath, renderPlaywrightDashboard(history));
await writeFile(
  path.join(galleryPath, "manifest.json"),
  `${JSON.stringify(createScreenshotManifest(screenshots, runIdentity), null, 2)}\n`,
);
await writeFile(
  path.join(galleryPath, "publish-stable-baseline"),
  `${shouldPublishStableMainBaseline({
    candidate: runIdentity,
    existingBaseline: await readOptionalJson(process.env.PLAYWRIGHT_EXISTING_STABLE_BASELINE_PATH),
    history,
  })}\n`,
);
await writeFile(
  path.join(galleryPath, "index.html"),
  renderScreenshotGallery({
    baselineAvailable: comparison.baselineAvailable,
    createdAt,
    dashboardUrl,
    pullRequestNumber,
    pullRequestUrl,
    reportUrl,
    result,
    runUrl,
    screenshots,
    screenshotsUrl,
    sha,
  }),
);
await writeFile(
  path.join(galleryPath, "review.json"),
  `${JSON.stringify({ screenshots, screenshotsUrl }, null, 2)}\n`,
);

console.log(
  `Playwright dashboard generated with ${history.length} runs and ${screenshots.length} screenshots.`,
);

async function collectScreenshots(
  resultsPath: string,
  outputPath: string,
): Promise<Array<Omit<PlaywrightScreenshot, "comparison">>> {
  const files = (await findPngFiles(resultsPath))
    .filter((file) => classifyPlaywrightScreenshot(file) !== undefined)
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
  validatePlaywrightScreenshotBudget(files.length, 0);
  const imagePath = path.join(outputPath, "images");
  await mkdir(imagePath, { recursive: true });

  const screenshots: Array<Omit<PlaywrightScreenshot, "comparison">> = [];
  let totalScreenshotBytes = 0;
  for (const [index, file] of files.entries()) {
    const info = await stat(file);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_PNG_SCREENSHOT_BYTES) {
      throw new Error(`Invalid screenshot size for ${file}`);
    }
    totalScreenshotBytes += info.size;
    validatePlaywrightScreenshotBudget(files.length, totalScreenshotBytes);
    const screenshot = await readFile(file);
    validatePngScreenshot(screenshot, file);
    const captureType = classifyPlaywrightScreenshot(file);
    if (captureType === undefined) continue;
    const source = path.relative(resultsPath, file);
    const baseName = sanitizeFileName(path.basename(file));
    const fileName = `${String(index + 1).padStart(3, "0")}-${baseName}`;
    await copyFile(file, path.join(imagePath, fileName));
    screenshots.push({
      captureType,
      fileName: `images/${fileName}`,
      hash: createHash("sha256").update(screenshot).digest("hex"),
      source,
      testId: testIdFromSource(source),
      title: screenshotTitleFromFileName(baseName),
    });
  }
  return screenshots;
}

async function findPngFiles(
  directory: string,
  depth = 0,
  budget = { entries: 0 },
): Promise<string[]> {
  if (depth > MAX_ARTIFACT_DEPTH) {
    throw new Error(`Playwright artifact exceeds maximum directory depth of ${MAX_ARTIFACT_DEPTH}`);
  }
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  budget.entries += entries.length;
  if (budget.entries > MAX_ARTIFACT_ENTRIES) {
    throw new Error(`Playwright artifact exceeds maximum entry count of ${MAX_ARTIFACT_ENTRIES}`);
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name === "attachments") return [];
      if (entry.isDirectory()) return findPngFiles(entryPath, depth + 1, budget);
      return entry.isFile() && entry.name.toLowerCase().endsWith(".png") ? [entryPath] : [];
    }),
  );
  return files.flat();
}

function sanitizeFileName(fileName: string): string {
  return fileName.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
}

function testIdFromSource(source: string): string {
  const directory = path.dirname(source);
  return directory === "." ? "Unknown test" : directory.split(path.sep).join(" / ");
}

function getRequiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function getOptionalHttpsEnvironmentVariable(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (!URL.canParse(value) || new URL(value).protocol !== "https:") {
    throw new Error(`${name} must use HTTPS`);
  }
  return value;
}

function getRequiredNumber(name: string): number {
  const value = Number(getRequiredEnvironmentVariable(name));
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function getOptionalNumber(name: string): number | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

async function readHistory(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function readOptionalJson(filePath: string | undefined): Promise<unknown> {
  if (!filePath) return undefined;
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > 1_000_000) {
      console.warn("Ignoring an invalid or oversized Playwright baseline manifest.");
      return undefined;
    }
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      console.warn("Ignoring an invalid Playwright baseline manifest.");
      return null;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
