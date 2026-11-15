import { describe, expect, it } from "vitest";
import type { PlaywrightPrCommentScreenshot } from "./playwright-pr-screenshot-comment.js";
import {
  buildPlaywrightPrScreenshotComment,
  PLAYWRIGHT_PR_SCREENSHOT_COMMENT_MARKER,
  screenshotMatchesSpecStem,
  selectPlaywrightPrFeatureFrames,
  specStemsFromChangedPaths,
} from "./playwright-pr-screenshot-comment.js";

describe("specStemsFromChangedPaths", () => {
  it("extracts Playwright spec stems from changed paths", () => {
    expect(
      specStemsFromChangedPaths([
        "apps/web/e2e/tool-activity-shell.spec.ts",
        "apps/web/src/components/ToolActivity.tsx",
        "apps/web/e2e/tool-activity-disclosure.spec.ts",
        "README.md",
      ]),
    ).toEqual(["tool-activity-disclosure", "tool-activity-shell"]);
  });
});

describe("screenshotMatchesSpecStem", () => {
  it("matches Playwright output directories that start with the spec stem", () => {
    expect(
      screenshotMatchesSpecStem(
        "tool-activity-shell-produc-bb211-n-in-every-disclosure-state-chromium/shell.png",
        "tool-activity-shell",
      ),
    ).toBe(true);
    expect(
      screenshotMatchesSpecStem(
        "tool-activity-disclosure-t-f2d47-s-collapsed-until-disclosed-chromium/complete.png",
        "tool-activity-disclosure",
      ),
    ).toBe(true);
    expect(
      screenshotMatchesSpecStem(
        "onboarding-conversation-fo-bf02c-rves-a-completed-connection-chromium/01.png",
        "tool-activity-shell",
      ),
    ).toBe(false);
  });

  it("matches output directories nested under a project folder", () => {
    expect(
      screenshotMatchesSpecStem(
        "www-marketing/homepage-screenshots-plugin-pages-chromium/07-submit.png",
        "homepage-screenshots",
      ),
    ).toBe(true);
  });
});

describe("selectPlaywrightPrFeatureFrames", () => {
  it("lists NEW checkpoints before CHANGED ones", () => {
    const selection = selectPlaywrightPrFeatureFrames({
      changedPaths: ["apps/web/e2e/tool-activity-shell.spec.ts"],
      screenshots: [
        screenshot({
          comparison: "changed",
          fileName: "images/001-shell-idle.png",
          source: "tool-activity-shell-x/shell-idle.png",
          title: "shell idle",
        }),
        screenshot({
          comparison: "new",
          fileName: "images/002-shell-live.png",
          source: "tool-activity-shell-x/shell-live.png",
          title: "shell live",
        }),
      ],
    });

    expect(selection).toEqual({
      frames: [
        expect.objectContaining({
          kind: "new",
          title: "shell live",
        }),
        expect.objectContaining({
          kind: "changed",
          title: "shell idle",
        }),
      ],
      omittedCount: 0,
    });
  });

  it("skips NEW checkpoints from specs outside the PR diff", () => {
    const selection = selectPlaywrightPrFeatureFrames({
      changedPaths: ["apps/web/e2e/plugin-marketplace.spec.ts"],
      screenshots: [
        screenshot({
          comparison: "new",
          fileName: "images/001-group-mentions.png",
          source: "group-chats-create-group-f-23e27-chromium/group-mentions.png",
          title: "group mentions",
        }),
      ],
    });

    expect(selection).toEqual({ frames: [], omittedCount: 0 });
  });

  it("includes CHANGED checkpoints only when their spec is in the PR diff", () => {
    const selection = selectPlaywrightPrFeatureFrames({
      changedPaths: ["apps/web/e2e/tool-activity-disclosure.spec.ts"],
      screenshots: [
        screenshot({
          comparison: "changed",
          fileName: "images/001-complete.png",
          source: "tool-activity-disclosure-t-f2d47-chromium/complete.png",
          title: "complete collapsed",
        }),
        screenshot({
          comparison: "changed",
          fileName: "images/002-onboarding.png",
          source: "onboarding-conversation-fo-bf02c-chromium/01.png",
          title: "onboarding",
        }),
        screenshot({
          comparison: "unchanged",
          fileName: "images/003-other.png",
          source: "tool-activity-disclosure-t-f2d47-chromium/other.png",
          title: "other",
        }),
      ],
    });

    expect(selection.frames).toEqual([
      expect.objectContaining({
        kind: "changed",
        title: "complete collapsed",
      }),
    ]);
    expect(selection.omittedCount).toBe(0);
  });

  it("returns an empty selection for suite-vs-main drift only", () => {
    const selection = selectPlaywrightPrFeatureFrames({
      changedPaths: ["apps/web/src/components/ToolActivity.tsx"],
      screenshots: [
        screenshot({
          comparison: "changed",
          fileName: "images/001-onboarding.png",
          source: "onboarding-x/01.png",
          title: "onboarding",
        }),
        screenshot({
          comparison: "changed",
          fileName: "images/002-settings.png",
          source: "settings-x/01.png",
          title: "settings",
        }),
      ],
    });

    expect(selection).toEqual({ frames: [], omittedCount: 0 });
  });

  it("caps the named list and reports how many were omitted", () => {
    const screenshots = Array.from({ length: 10 }, (_, index) =>
      screenshot({
        comparison: "new",
        fileName: `images/${String(index + 1).padStart(3, "0")}-frame.png`,
        source: `tool-activity-shell-x/frame-${index}.png`,
        title: `frame ${index + 1}`,
      }),
    );

    const selection = selectPlaywrightPrFeatureFrames({
      changedPaths: ["apps/web/e2e/tool-activity-shell.spec.ts"],
      limit: 8,
      screenshots,
    });

    expect(selection.frames).toHaveLength(8);
    expect(selection.frames.map((frame) => frame.title)).toEqual([
      "frame 1",
      "frame 2",
      "frame 3",
      "frame 4",
      "frame 5",
      "frame 6",
      "frame 7",
      "frame 8",
    ]);
    expect(selection.omittedCount).toBe(2);
  });
});

describe("buildPlaywrightPrScreenshotComment", () => {
  const urls = {
    dashboardUrl: "https://example.com/playwright/index.html",
    galleryUrl: "https://example.com/playwright/prs/452/index.html",
    runUrl: "https://github.com/example/rakazo/actions/runs/1",
    screenshotsUrl: "https://example.com/playwright/runs/1-1/screenshots/index.html",
    sha: "abcdef1234567890",
  };

  it("shows NEW frames inline and keeps gallery links secondary", () => {
    const body = buildPlaywrightPrScreenshotComment({
      ...urls,
      changedPaths: ["apps/web/e2e/tool-activity-shell.spec.ts"],
      screenshots: [
        screenshot({
          comparison: "new",
          fileName: "images/010-shell-live-collapsed-desktop-1440x900.png",
          source: "tool-activity-shell-x/shell-live-collapsed-desktop-1440x900.png",
          title: "shell live collapsed desktop 1440x900",
        }),
      ],
    });

    expect(body).toContain(PLAYWRIGHT_PR_SCREENSHOT_COMMENT_MARKER);
    expect(body).toContain("### Playwright screenshots");
    expect(body).toContain("Feature frames for this PR:");
    expect(body).toContain(
      "**shell live collapsed desktop 1440x900** (new)\n\n![shell live collapsed desktop 1440x900](https://example.com/playwright/runs/1-1/screenshots/images/010-shell-live-collapsed-desktop-1440x900.png)",
    );
    expect(body).toContain(
      "[Open screenshot gallery](https://example.com/playwright/prs/452/index.html) · [Dashboard](https://example.com/playwright/index.html) · [CI run](https://github.com/example/rakazo/actions/runs/1)",
    );
    expect(body).toContain("Updated for commit `abcdef1`.");
    expect(body).toContain("<!-- screenshot-commit:abcdef1234567890 -->");
    expect(body).not.toContain("—");
  });

  it("includes spec-touched CHANGED frames after NEW frames", () => {
    const body = buildPlaywrightPrScreenshotComment({
      ...urls,
      changedPaths: [
        "apps/web/e2e/tool-activity-disclosure.spec.ts",
        "apps/web/e2e/tool-activity-shell.spec.ts",
      ],
      screenshots: [
        screenshot({
          comparison: "changed",
          fileName: "images/020-complete-collapsed-desktop-1440x900.png",
          source:
            "tool-activity-disclosure-t-f2d47-chromium/complete-collapsed-desktop-1440x900.png",
          title: "complete collapsed desktop 1440x900",
        }),
        screenshot({
          comparison: "new",
          fileName: "images/010-shell-live.png",
          source: "tool-activity-shell-x/shell-live.png",
          title: "shell live",
        }),
        screenshot({
          comparison: "changed",
          fileName: "images/030-onboarding.png",
          source: "onboarding-x/01.png",
          title: "onboarding",
        }),
      ],
    });

    expect(body.indexOf("**shell live** (new)")).toBeGreaterThan(-1);
    expect(body.indexOf("**complete collapsed desktop 1440x900** (changed)")).toBeGreaterThan(
      body.indexOf("**shell live** (new)"),
    );
    expect(body).not.toContain("onboarding");
  });

  it("says so in one line when only suite drift remains", () => {
    const body = buildPlaywrightPrScreenshotComment({
      ...urls,
      changedPaths: ["apps/web/src/components/ToolActivity.tsx"],
      screenshots: [
        screenshot({
          comparison: "changed",
          fileName: "images/001-onboarding.png",
          source: "onboarding-x/01.png",
          title: "onboarding",
        }),
      ],
    });

    expect(body).toContain("No new feature frames; gallery is suite-vs-main drift.");
    expect(body).not.toContain("Feature frames for this PR:");
    expect(body).not.toContain("onboarding");
    expect(body).toContain("[Open screenshot gallery]");
  });

  it("caps named frames and points to the gallery for the rest", () => {
    const screenshots = Array.from({ length: 10 }, (_, index) =>
      screenshot({
        comparison: "new",
        fileName: `images/${String(index + 1).padStart(3, "0")}-frame.png`,
        source: `tool-activity-shell-x/frame-${index}.png`,
        title: `frame ${index + 1}`,
      }),
    );

    const body = buildPlaywrightPrScreenshotComment({
      ...urls,
      changedPaths: ["apps/web/e2e/tool-activity-shell.spec.ts"],
      screenshots,
    });

    expect(body).toContain(
      "![frame 8](https://example.com/playwright/runs/1-1/screenshots/images/008-frame.png)",
    );
    expect(body).not.toContain("frame 9");
    expect(body).toContain("+2 more in the gallery");
  });

  it("neutralizes Markdown and HTML syntax in contributor-controlled titles", () => {
    const body = buildPlaywrightPrScreenshotComment({
      ...urls,
      changedPaths: ["apps/web/e2e/tool-activity-shell.spec.ts"],
      screenshots: [
        screenshot({
          comparison: "new",
          fileName: "images/010-crafted.png",
          source: "tool-activity-shell-x/crafted.png",
          title: "evil]\n**bold** `code` _em_ #heading [link] <details>&",
        }),
      ],
    });

    const label =
      "evil\\] \\*\\*bold\\*\\* \\`code\\` \\_em\\_ \\#heading \\[link\\] &lt;details&gt;&amp;";
    expect(body).toContain(`**${label}** (new)`);
    expect(body).toContain(
      `![${label}](https://example.com/playwright/runs/1-1/screenshots/images/010-crafted.png)`,
    );
    expect(body).not.toContain("\n**bold**");
    expect(body).not.toContain("`code`");
    expect(body).not.toContain("<details>");
  });
});

function screenshot(
  overrides: Partial<PlaywrightPrCommentScreenshot> = {},
): PlaywrightPrCommentScreenshot {
  return {
    captureType: "checkpoint",
    comparison: "new",
    fileName: "images/001-checkpoint.png",
    source: "golden-chromium/checkpoint.png",
    title: "checkpoint",
    ...overrides,
  };
}
