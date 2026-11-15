import { readFile } from "node:fs/promises";
import type { PlaywrightPrCommentScreenshot } from "../playwright-pr-screenshot-comment.js";
import { buildPlaywrightPrScreenshotComment } from "../playwright-pr-screenshot-comment.js";

const [reviewPath, changedPathsPath] = process.argv.slice(2);

if (!reviewPath || !changedPathsPath) {
  throw new Error(
    "Usage: build-playwright-pr-screenshot-comment <review-json-path> <changed-paths-file>",
  );
}

const review = JSON.parse(await readFile(reviewPath, "utf8")) as {
  screenshots?: PlaywrightPrCommentScreenshot[];
  screenshotsUrl?: string;
};
const changedPaths = (await readFile(changedPathsPath, "utf8"))
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

if (!Array.isArray(review.screenshots)) {
  throw new Error("review.json must include a screenshots array");
}
if (
  typeof review.screenshotsUrl !== "string" ||
  !URL.canParse(review.screenshotsUrl) ||
  new URL(review.screenshotsUrl).protocol !== "https:"
) {
  throw new Error("review.json must include an https screenshotsUrl");
}

const galleryUrl = getRequiredHttpsEnvironmentVariable("PLAYWRIGHT_GALLERY_URL");
const dashboardUrl = getRequiredHttpsEnvironmentVariable("PLAYWRIGHT_DASHBOARD_URL");
const runUrl = getRequiredHttpsEnvironmentVariable("PLAYWRIGHT_RUN_URL");
const sha = getRequiredEnvironmentVariable("PLAYWRIGHT_SHA");

process.stdout.write(
  `${buildPlaywrightPrScreenshotComment({
    changedPaths,
    dashboardUrl,
    galleryUrl,
    runUrl,
    screenshots: review.screenshots,
    screenshotsUrl: review.screenshotsUrl,
    sha,
  })}\n`,
);

function getRequiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function getRequiredHttpsEnvironmentVariable(name: string): string {
  const value = getRequiredEnvironmentVariable(name);
  if (!URL.canParse(value) || new URL(value).protocol !== "https:") {
    throw new Error(`${name} must use HTTPS`);
  }
  return value;
}
