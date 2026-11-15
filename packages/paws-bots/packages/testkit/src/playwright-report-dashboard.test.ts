import { describe, expect, it } from "vitest";
import type { PlaywrightRun, PlaywrightScreenshot } from "./playwright-report-dashboard.js";
import {
  classifyPlaywrightScreenshot,
  compareScreenshotsWithBaseline,
  createScreenshotManifest,
  MAX_PLAYWRIGHT_SCREENSHOT_BYTES,
  MAX_PLAYWRIGHT_SCREENSHOT_COUNT,
  renderMobileScreenshotGallery,
  renderPlaywrightDashboard,
  renderScreenshotGallery,
  shouldPublishStableMainBaseline,
  updatePlaywrightHistory,
  validatePlaywrightScreenshotBudget,
} from "./playwright-report-dashboard.js";

describe("validatePlaywrightScreenshotBudget", () => {
  it("accepts the exact screenshot count and aggregate byte limits", () => {
    expect(() =>
      validatePlaywrightScreenshotBudget(
        MAX_PLAYWRIGHT_SCREENSHOT_COUNT,
        MAX_PLAYWRIGHT_SCREENSHOT_BYTES,
      ),
    ).not.toThrow();
  });

  it("rejects the first screenshot and byte beyond their limits", () => {
    expect(() =>
      validatePlaywrightScreenshotBudget(MAX_PLAYWRIGHT_SCREENSHOT_COUNT + 1, 0),
    ).toThrow(
      new RegExp(
        `${MAX_PLAYWRIGHT_SCREENSHOT_COUNT + 1} screenshots; maximum is ${MAX_PLAYWRIGHT_SCREENSHOT_COUNT}`,
      ),
    );
    expect(() =>
      validatePlaywrightScreenshotBudget(1, MAX_PLAYWRIGHT_SCREENSHOT_BYTES + 1),
    ).toThrow(/maximum total size of 262144000 bytes/);
  });
});

describe("classifyPlaywrightScreenshot", () => {
  it("excludes automatic successful-test captures from visual review", () => {
    expect(classifyPlaywrightScreenshot("test-finished-1.png")).toBeUndefined();
    expect(classifyPlaywrightScreenshot("nested/test-finished-12.PNG")).toBeUndefined();
  });

  it("keeps intentional checkpoints and automatic failure captures", () => {
    expect(classifyPlaywrightScreenshot("01-onboarding-complete.png")).toBe("checkpoint");
    expect(classifyPlaywrightScreenshot("nested/test-failed-1.png")).toBe("failure");
  });
});

describe("compareScreenshotsWithBaseline", () => {
  it("marks matching, changed, and new screenshots using source and SHA-256", () => {
    const unchanged = getScreenshot({ hash: "a".repeat(64), source: "test-a/checkpoint.png" });
    const changed = getScreenshot({ hash: "b".repeat(64), source: "test-b/checkpoint.png" });
    const added = getScreenshot({ hash: "c".repeat(64), source: "test-c/checkpoint.png" });
    const baseline = createScreenshotManifest([
      { ...unchanged, comparison: "unavailable" },
      { ...changed, comparison: "unavailable", hash: "d".repeat(64) },
    ]);

    expect(compareScreenshotsWithBaseline([unchanged, changed, added], baseline)).toEqual({
      baselineAvailable: true,
      screenshots: [
        { ...unchanged, comparison: "unchanged" },
        { ...changed, comparison: "changed" },
        { ...added, comparison: "new" },
      ],
    });
  });

  it("does not claim screenshots are new when the baseline is unavailable or invalid", () => {
    const screenshot = getScreenshot();

    expect(compareScreenshotsWithBaseline([screenshot], undefined)).toEqual({
      baselineAvailable: false,
      screenshots: [{ ...screenshot, comparison: "unavailable" }],
    });
    expect(
      compareScreenshotsWithBaseline([screenshot], {
        screenshots: [{ ...screenshot, hash: "not-a-sha256" }],
        version: 1,
      }),
    ).toEqual({
      baselineAvailable: false,
      screenshots: [{ ...screenshot, comparison: "unavailable" }],
    });
  });

  it("ignores run identity when comparing screenshot hashes", () => {
    const screenshot = getScreenshot();
    const baseline = createScreenshotManifest([{ ...screenshot, comparison: "unavailable" }], {
      attempt: 1,
      id: "100",
    });

    expect(compareScreenshotsWithBaseline([screenshot], baseline)).toEqual({
      baselineAvailable: true,
      screenshots: [{ ...screenshot, comparison: "unchanged" }],
    });
  });
});

describe("updatePlaywrightHistory", () => {
  it("places the current attempt first and replaces an existing copy", () => {
    const previousRun = getRun({ id: "100", runNumber: 8 });
    const currentRun = getRun({ id: "200", runNumber: 9 });
    const existingCurrentRun = getRun({
      id: currentRun.id,
      reportUrl: "https://example.com/old-report",
      runNumber: currentRun.runNumber,
    });

    expect(updatePlaywrightHistory([previousRun, existingCurrentRun], currentRun)).toEqual([
      currentRun,
      previousRun,
    ]);
  });

  it("keeps the latest 100 valid runs", () => {
    const previousRuns = Array.from({ length: 105 }, (_, index) =>
      getRun({ id: String(index), runNumber: index }),
    );

    const history = updatePlaywrightHistory(previousRuns, getRun());

    expect(history).toHaveLength(100);
    expect(history[0]?.id).toBe("200");
    expect(history.at(-1)?.id).toBe("6");
  });

  it("keeps a delayed older run behind the newest run", () => {
    const newestRun = getRun({ id: "300", runNumber: 11 });
    const delayedRun = getRun({ id: "250", runNumber: 10 });

    expect(updatePlaywrightHistory([newestRun], delayedRun)).toEqual([newestRun, delayedRun]);
  });

  it("orders rerun attempts from newest to oldest", () => {
    const firstAttempt = getRun({ attempt: 1 });
    const secondAttempt = getRun({ attempt: 2 });

    expect(updatePlaywrightHistory([secondAttempt], firstAttempt)).toEqual([
      secondAttempt,
      firstAttempt,
    ]);
  });

  it("drops malformed and unsafe history entries", () => {
    const currentRun = getRun();

    expect(
      updatePlaywrightHistory(
        [null, { id: "broken" }, getRun({ reportUrl: "javascript:alert(1)" })],
        currentRun,
      ),
    ).toEqual([currentRun]);
  });

  it("keeps screenshot-only pull request runs", () => {
    const pullRequestRun = getRun({
      branch: "external-contributor-branch",
      event: "pull_request",
      pullRequestNumber: 59,
      pullRequestUrl: "https://github.com/example/repository/pull/59",
      reportUrl: undefined,
    });

    expect(updatePlaywrightHistory([], pullRequestRun)).toEqual([pullRequestRun]);
  });
});

describe("shouldPublishStableMainBaseline", () => {
  const screenshot = getScreenshot();

  it("publishes when this successful main run is the newest and no baseline exists", () => {
    const current = getRun({ id: "300", runNumber: 12 });
    const pullRequest = getRun({
      event: "pull_request",
      id: "250",
      pullRequestNumber: 59,
      pullRequestUrl: "https://github.com/example/repository/pull/59",
      reportUrl: undefined,
    });

    expect(
      shouldPublishStableMainBaseline({
        candidate: current,
        existingBaseline: undefined,
        history: updatePlaywrightHistory([pullRequest], current),
      }),
    ).toBe(true);
  });

  it("does not let an older or rerun main replace a newer published baseline", () => {
    const newest = getRun({ attempt: 2, id: "300", runNumber: 12 });
    const delayed = getRun({ id: "250", runNumber: 10 });
    const history = updatePlaywrightHistory([newest], delayed);
    const newerBaseline = createScreenshotManifest(
      [{ ...screenshot, comparison: "unavailable" }],
      newest,
    );

    expect(
      shouldPublishStableMainBaseline({
        candidate: delayed,
        existingBaseline: newerBaseline,
        history,
      }),
    ).toBe(false);
    expect(
      shouldPublishStableMainBaseline({
        candidate: delayed,
        existingBaseline: newerBaseline,
        history: [delayed],
      }),
    ).toBe(false);
  });

  it("preserves an identity-less baseline but replaces an older identified baseline", () => {
    const current = getRun({ id: "300", runNumber: 12 });
    const previous = getRun({ id: "200", runNumber: 9 });
    const history = updatePlaywrightHistory([previous], current);

    expect(
      shouldPublishStableMainBaseline({
        candidate: current,
        existingBaseline: createScreenshotManifest([{ ...screenshot, comparison: "unavailable" }]),
        history,
      }),
    ).toBe(false);
    expect(
      shouldPublishStableMainBaseline({
        candidate: current,
        existingBaseline: null,
        history,
      }),
    ).toBe(false);
    expect(
      shouldPublishStableMainBaseline({
        candidate: current,
        existingBaseline: createScreenshotManifest(
          [{ ...screenshot, comparison: "unavailable" }],
          previous,
        ),
        history,
      }),
    ).toBe(true);
  });
});

describe("renderPlaywrightDashboard", () => {
  it("embeds run history without allowing a script breakout", () => {
    const html = renderPlaywrightDashboard([
      getRun({ branch: "</script><script>alert(1)</script>" }),
    ]);

    expect(html).not.toContain("</script><script>alert(1)</script>");
    expect(html).toContain("\\u003c/script>\\u003cscript>alert(1)\\u003c/script>");
    expect(html).toContain("latestReport.href = latestWithReport.reportUrl");
    expect(html).toContain("latestScreenshots.href = history[0].screenshotsUrl");
  });
});

describe("renderScreenshotGallery", () => {
  it("renders scan-friendly images and escapes labels", () => {
    const html = renderScreenshotGallery({
      baselineAvailable: true,
      createdAt: "2026-08-16T10:00:00.000Z",
      dashboardUrl: "https://example.com/playwright/index.html",
      reportUrl: "https://example.com/report",
      result: "success",
      runUrl: "https://github.com/example/repository/actions/runs/200",
      screenshots: [
        {
          captureType: "checkpoint",
          comparison: "new",
          fileName: "images/001-shell.png",
          hash: "a".repeat(64),
          source: "golden/<script>.png",
          testId: "golden shell",
          title: "main <script>alert(1)</script>",
        },
      ],
      screenshotsUrl: "https://example.com/playwright/runs/200-1/screenshots/index.html",
      sha: "abcdef1234567890",
    });

    expect(html).toContain(
      'src="https://example.com/playwright/runs/200-1/screenshots/images/001-shell.png"',
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("main &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("repeat(var(--gallery-columns, 1), minmax(0, 1fr))");
    expect(html).toContain('data-columns="1" aria-label="One column" aria-pressed="true"');
    expect(html).toContain('data-columns="4" aria-label="Four columns" aria-pressed="false"');
    expect(html).toContain("initialColumns = localStorage.getItem(storageKey) || initialColumns");
    expect(html).toContain('<span class="badge checkpoint">CHECKPOINT</span>');
    expect(html).toContain('<span class="badge new">NEW</span>');
    expect(html).toContain('data-filter="new" aria-pressed="true"');
    expect(html).toContain('data-filter="review" aria-pressed="false"');
    expect(html).toContain("Compared with latest successful main run");
    expect(html).toContain(`@media (max-width: 900px) {
      header { align-items: start; flex-direction: column; }
      .toolbar { align-items: start; flex-direction: column; }
      .view-options { display: none; }
      .gallery { grid-template-columns: 1fr; }
    }`);
  });

  it("links a pull request without exposing an untrusted HTML report", () => {
    const html = renderScreenshotGallery({
      baselineAvailable: false,
      createdAt: "2026-08-16T10:00:00.000Z",
      dashboardUrl: "https://example.com/playwright/index.html",
      pullRequestNumber: 59,
      pullRequestUrl: "https://github.com/example/repository/pull/59",
      result: "success",
      runUrl: "https://github.com/example/repository/actions/runs/200",
      screenshots: [],
      screenshotsUrl: "https://example.com/playwright/runs/200-1/screenshots/index.html",
      sha: "abcdef1234567890",
    });

    expect(html).toContain('href="https://github.com/example/repository/pull/59">PR #59</a>');
    expect(html).not.toContain("Full report");
    expect(html).toContain("PR #59 screenshots");
  });

  it("clearly labels automatic failure captures without inventing a comparison", () => {
    const html = renderScreenshotGallery({
      baselineAvailable: false,
      createdAt: "2026-08-16T10:00:00.000Z",
      dashboardUrl: "https://example.com/playwright/index.html",
      result: "failure",
      runUrl: "https://github.com/example/repository/actions/runs/200",
      screenshots: [
        {
          captureType: "failure",
          comparison: "unavailable",
          fileName: "images/001-test-failed-1.png",
          hash: "f".repeat(64),
          source: "approval-chromium/test-failed-1.png",
          testId: "approval chromium",
          title: "test failed 1",
        },
      ],
      screenshotsUrl: "https://example.com/playwright/runs/200-1/screenshots/index.html",
      sha: "abcdef1234567890",
    });

    expect(html).toContain('<span class="badge failure">FAILED</span>');
    expect(html).toContain('<span class="badge unavailable">NO BASELINE</span>');
    expect(html).toContain("Automatic failure capture");
    expect(html).toContain('data-filter="all" aria-pressed="true"');
    expect(html).toContain('data-filter="new" aria-pressed="false" disabled');
  });

  it("renders the same responsive gallery as a mobile catalog without review controls", () => {
    const html = renderMobileScreenshotGallery({
      createdAt: "2026-08-16T10:00:00.000Z",
      runUrl: "https://github.com/example/repository/actions/runs/200",
      screenshots: [
        {
          fileName: "images/01-inbox.png",
          source: "01-inbox.png",
          title: "inbox",
        },
      ],
      screenshotsUrl: "https://example.com/playwright/mobile-android/runs/200-1/index.html",
      sha: "abcdef1234567890",
    });

    expect(html).toContain("<h1>Android screenshots</h1>");
    expect(html).toContain("<strong>inbox</strong>");
    expect(html).toContain(
      'src="https://example.com/playwright/mobile-android/runs/200-1/images/01-inbox.png"',
    );
    expect(html).not.toContain('class="badges"');
    expect(html).not.toContain("SHA-256");
    expect(html).not.toContain("NO BASELINE");
    expect(html).not.toContain('class="filters"');
    expect(html).not.toContain('document.querySelectorAll("figure")');
    expect(html).not.toContain("All runs");
  });
});

function getRun(overrides: Partial<PlaywrightRun> = {}): PlaywrightRun {
  return {
    attempt: 1,
    branch: "main",
    createdAt: "2026-08-16T10:00:00.000Z",
    event: "push",
    id: "200",
    reportUrl: "https://example.com/playwright/runs/200-1/report/index.html",
    result: "success",
    runNumber: 10,
    runUrl: "https://github.com/example/repository/actions/runs/200",
    screenshotCount: 12,
    screenshotsUrl: "https://example.com/playwright/runs/200-1/screenshots/index.html",
    sha: "abcdef1234567890",
    ...overrides,
  };
}

function getScreenshot(
  overrides: Partial<Omit<PlaywrightScreenshot, "comparison">> = {},
): Omit<PlaywrightScreenshot, "comparison"> {
  return {
    captureType: "checkpoint",
    fileName: "images/001-checkpoint.png",
    hash: "a".repeat(64),
    source: "golden-chromium/checkpoint.png",
    testId: "golden chromium",
    title: "checkpoint",
    ...overrides,
  };
}
