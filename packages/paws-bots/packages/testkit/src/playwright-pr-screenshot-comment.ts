import type { PlaywrightScreenshot } from "./playwright-report-dashboard.js";
import commitMarker from "./screenshot-commit-marker.json" with { type: "json" };

export const PLAYWRIGHT_PR_SCREENSHOT_COMMENT_MARKER = "<!-- rakazo-playwright-screenshots -->";
export const PLAYWRIGHT_PR_FEATURE_FRAME_LIMIT = 8;

export type PlaywrightPrCommentScreenshot = Pick<
  PlaywrightScreenshot,
  "captureType" | "comparison" | "fileName" | "source" | "title"
>;

export type PlaywrightPrFeatureFrame = PlaywrightPrCommentScreenshot & {
  kind: "changed" | "new";
};

export type PlaywrightPrFeatureFrameSelection = {
  frames: PlaywrightPrFeatureFrame[];
  omittedCount: number;
};

const SPEC_FILE_PATTERN = /^(.*)\.spec\.[cm]?[jt]sx?$/i;

export function specStemsFromChangedPaths(changedPaths: readonly string[]): string[] {
  const stems = new Set<string>();
  for (const changedPath of changedPaths) {
    const baseName = changedPath.split(/[\\/]/).at(-1) ?? changedPath;
    const match = SPEC_FILE_PATTERN.exec(baseName);
    if (match?.[1]) stems.add(match[1].toLowerCase());
  }
  return [...stems].sort();
}

export function screenshotMatchesSpecStem(source: string, specStem: string): boolean {
  // Projects may nest output under their own folder, so use the test's directory, not the first segment.
  const directory = (source.split(/[\\/]/).at(-2) ?? source).toLowerCase();
  const stem = specStem.toLowerCase();
  return directory === stem || directory.startsWith(`${stem}-`);
}

export function selectPlaywrightPrFeatureFrames(input: {
  changedPaths: readonly string[];
  limit?: number;
  screenshots: readonly PlaywrightPrCommentScreenshot[];
}): PlaywrightPrFeatureFrameSelection {
  const limit = input.limit ?? PLAYWRIGHT_PR_FEATURE_FRAME_LIMIT;
  const stems = specStemsFromChangedPaths(input.changedPaths);
  // The main baseline can trail main by hours, so checkpoints other merged PRs added also
  // look new. Only specs this PR touched say anything about this PR.
  const checkpoints = input.screenshots.filter(
    (screenshot) =>
      screenshot.captureType === "checkpoint" &&
      stems.some((stem) => screenshotMatchesSpecStem(screenshot.source, stem)),
  );
  const frames: PlaywrightPrFeatureFrame[] = [
    ...checkpoints
      .filter((screenshot) => screenshot.comparison === "new")
      .map((screenshot) => ({ ...screenshot, kind: "new" as const })),
    ...checkpoints
      .filter((screenshot) => screenshot.comparison === "changed")
      .map((screenshot) => ({ ...screenshot, kind: "changed" as const })),
  ];

  return {
    frames: frames.slice(0, limit),
    omittedCount: Math.max(0, frames.length - limit),
  };
}

export function buildPlaywrightPrScreenshotComment(input: {
  changedPaths: readonly string[];
  dashboardUrl: string;
  galleryUrl: string;
  limit?: number;
  runUrl: string;
  screenshots: readonly PlaywrightPrCommentScreenshot[];
  screenshotsUrl: string;
  sha: string;
}): string {
  const { frames, omittedCount } = selectPlaywrightPrFeatureFrames(input);
  const galleryBaseUrl = new URL(".", input.screenshotsUrl);
  const secondaryLinks = [
    `[Open screenshot gallery](${input.galleryUrl})`,
    `[Dashboard](${input.dashboardUrl})`,
    `[CI run](${input.runUrl})`,
  ].join(" · ");

  const featureSection =
    frames.length === 0
      ? "No new feature frames; gallery is suite-vs-main drift."
      : [
          "Feature frames for this PR:",
          ...frames.map((frame) => {
            const imageUrl = new URL(frame.fileName, galleryBaseUrl).toString();
            const label = escapeMarkdownLinkLabel(frame.title);
            return `**${label}** (${frame.kind})\n\n![${label}](${imageUrl})`;
          }),
          ...(omittedCount > 0 ? [`+${omittedCount} more in the gallery`] : []),
        ].join("\n\n");

  return [
    PLAYWRIGHT_PR_SCREENSHOT_COMMENT_MARKER,
    commitMarker.template.replace("{sha}", input.sha),
    "### Playwright screenshots",
    "",
    featureSection,
    "",
    secondaryLinks,
    "",
    `Updated for commit \`${input.sha.slice(0, 7)}\`.`,
  ].join("\n");
}

function escapeMarkdownLinkLabel(value: string): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  const label = normalized.length > 0 ? normalized : "screenshot";
  return label
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("`", "\\`")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("#", "\\#");
}
