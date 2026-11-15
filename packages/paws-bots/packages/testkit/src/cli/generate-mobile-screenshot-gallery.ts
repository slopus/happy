import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MobileScreenshot } from "../playwright-report-dashboard.js";
import {
  MAX_PLAYWRIGHT_SCREENSHOT_BYTES,
  renderMobileScreenshotGallery,
  screenshotTitleFromFileName,
} from "../playwright-report-dashboard.js";
import { validatePngScreenshot } from "../png-validation.js";

const [screenshotsPath, galleryPath] = process.argv.slice(2);
const MAX_SCREENSHOT_COUNT = 100;

if (!screenshotsPath || !galleryPath) {
  throw new Error("Usage: generate-mobile-screenshot-gallery <screenshots-path> <gallery-path>");
}

const screenshotsUrl = getHttpsEnvironmentVariable("MOBILE_SCREENSHOTS_URL");
const entries = (await readdir(screenshotsPath, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
  .sort((left, right) => left.name.localeCompare(right.name));

if (entries.length === 0 || entries.length > MAX_SCREENSHOT_COUNT) {
  throw new Error(`Expected between 1 and ${MAX_SCREENSHOT_COUNT} mobile screenshots`);
}

const imagesPath = path.join(galleryPath, "images");
await mkdir(imagesPath, { recursive: true });

let totalBytes = 0;
const screenshots: MobileScreenshot[] = [];
for (const entry of entries) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.png$/i.test(entry.name)) {
    throw new Error(`Unsafe mobile screenshot filename: ${entry.name}`);
  }
  const sourcePath = path.join(screenshotsPath, entry.name);
  const screenshot = await readFile(sourcePath);
  validatePngScreenshot(screenshot, sourcePath);
  totalBytes += screenshot.byteLength;
  if (totalBytes > MAX_PLAYWRIGHT_SCREENSHOT_BYTES) {
    throw new Error("Mobile screenshot catalog exceeds its size limit");
  }
  await writeFile(path.join(imagesPath, entry.name), screenshot);
  screenshots.push({
    fileName: `images/${entry.name}`,
    source: entry.name,
    title: screenshotTitleFromFileName(entry.name),
  });
}

await writeFile(
  path.join(galleryPath, "index.html"),
  renderMobileScreenshotGallery({
    createdAt: new Date().toISOString(),
    runUrl: getHttpsEnvironmentVariable("MOBILE_RUN_URL"),
    screenshots,
    screenshotsUrl,
    sha: getEnvironmentVariable("MOBILE_SHA"),
  }),
);

console.log(`Mobile screenshot gallery generated with ${screenshots.length} views.`);

function getEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function getHttpsEnvironmentVariable(name: string): string {
  const value = getEnvironmentVariable(name);
  if (!URL.canParse(value) || new URL(value).protocol !== "https:") {
    throw new Error(`${name} must use HTTPS`);
  }
  return value;
}
