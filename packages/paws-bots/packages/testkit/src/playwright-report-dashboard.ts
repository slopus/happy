const MAX_HISTORY_LENGTH = 100;
export const MAX_PLAYWRIGHT_SCREENSHOT_COUNT = 1_000;
export const MAX_PLAYWRIGHT_SCREENSHOT_BYTES = 250 * 1024 * 1024;
const SHARED_PAGE_STYLES = `
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #09090b; color: #fafafa; }
    * { box-sizing: border-box; }
    header { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 32px; }
    h1 { margin: 0; font-size: clamp(2rem, 6vw, 4.5rem); letter-spacing: -0.06em; }
    .eyebrow { margin: 0 0 10px; color: #c4b5fd; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; }
    .subtitle { margin: 10px 0 0; color: #a1a1aa; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; }
    .button { display: inline-flex; align-items: center; min-height: 40px; padding: 0 16px; border: 1px solid #3f3f46; border-radius: 999px; color: #fafafa; text-decoration: none; background: rgba(24, 24, 27, 0.78); }
    .button:hover { border-color: #a78bfa; background: #2e1065; }
`;

export type PlaywrightRun = {
  attempt: number;
  branch: string;
  createdAt: string;
  event: string;
  id: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  reportUrl?: string;
  result: string;
  runNumber: number;
  runUrl: string;
  screenshotCount: number;
  screenshotsUrl: string;
  sha: string;
};

export type PlaywrightScreenshot = {
  captureType: "checkpoint" | "failure";
  comparison: "changed" | "new" | "unavailable" | "unchanged";
  fileName: string;
  hash: string;
  source: string;
  testId: string;
  title: string;
};

export type PlaywrightScreenshotManifest = {
  attempt?: number;
  id?: string;
  // Older manifests predate fileName; it lets agents link a run's images.
  screenshots: Array<PlaywrightScreenshotMetadata & { fileName?: string }>;
  version: 1;
};

export type PlaywrightScreenshotMetadata = Omit<PlaywrightScreenshot, "comparison" | "fileName">;

export type MobileScreenshot = Pick<PlaywrightScreenshot, "fileName" | "source" | "title">;

export function validatePlaywrightScreenshotBudget(count: number, totalBytes: number): void {
  if (count > MAX_PLAYWRIGHT_SCREENSHOT_COUNT) {
    throw new Error(
      `Playwright artifact contains ${count} screenshots; maximum is ${MAX_PLAYWRIGHT_SCREENSHOT_COUNT}`,
    );
  }
  if (totalBytes > MAX_PLAYWRIGHT_SCREENSHOT_BYTES) {
    throw new Error(
      `Playwright screenshots exceed maximum total size of ${MAX_PLAYWRIGHT_SCREENSHOT_BYTES} bytes`,
    );
  }
}

export function classifyPlaywrightScreenshot(
  fileName: string,
): PlaywrightScreenshot["captureType"] | undefined {
  const baseName = fileName.split(/[\\/]/).at(-1) ?? fileName;
  if (/^test-finished(?:-\d+)?\.png$/i.test(baseName)) return undefined;
  return /^test-failed(?:-\d+)?\.png$/i.test(baseName) ? "failure" : "checkpoint";
}

export function screenshotTitleFromFileName(fileName: string): string {
  return fileName
    .replace(/\.png$/i, "")
    .replace(/^\d+-/, "")
    .replaceAll(/[-_]+/g, " ");
}

export function createScreenshotManifest(
  screenshots: PlaywrightScreenshot[],
  run?: { attempt: number; id: string },
): PlaywrightScreenshotManifest {
  return {
    ...(run === undefined ? {} : { attempt: run.attempt, id: run.id }),
    screenshots: screenshots.map(({ captureType, fileName, hash, source, testId, title }) => ({
      captureType,
      fileName,
      hash,
      source,
      testId,
      title,
    })),
    version: 1,
  };
}

export function compareScreenshotsWithBaseline(
  screenshots: Array<Omit<PlaywrightScreenshot, "comparison">>,
  baseline: unknown,
): { baselineAvailable: boolean; screenshots: PlaywrightScreenshot[] } {
  if (!isScreenshotManifest(baseline)) {
    return {
      baselineAvailable: false,
      screenshots: screenshots.map((screenshot) => ({
        ...screenshot,
        comparison: "unavailable",
      })),
    };
  }

  const baselineHashes = new Map(
    baseline.screenshots.map((screenshot) => [screenshot.source, screenshot.hash]),
  );
  return {
    baselineAvailable: true,
    screenshots: screenshots.map((screenshot) => {
      const baselineHash = baselineHashes.get(screenshot.source);
      return {
        ...screenshot,
        comparison:
          baselineHash === undefined
            ? "new"
            : baselineHash === screenshot.hash
              ? "unchanged"
              : "changed",
      };
    }),
  };
}

export function updatePlaywrightHistory(
  existingHistory: unknown,
  run: PlaywrightRun,
): PlaywrightRun[] {
  const history = Array.isArray(existingHistory) ? existingHistory.filter(isPlaywrightRun) : [];

  return [
    run,
    ...history.filter(
      (previousRun) => previousRun.id !== run.id || previousRun.attempt !== run.attempt,
    ),
  ]
    .sort(compareRunRecency)
    .slice(0, MAX_HISTORY_LENGTH);
}

export function shouldPublishStableMainBaseline(input: {
  candidate: { attempt: number; id: string };
  existingBaseline: unknown;
  history: unknown;
}): boolean {
  const history = Array.isArray(input.history) ? input.history.filter(isPlaywrightRun) : [];
  const latestMain = history.find(
    (run) => run.event !== "pull_request" && run.branch === "main" && run.result === "success",
  );
  if (
    latestMain === undefined ||
    latestMain.id !== input.candidate.id ||
    latestMain.attempt !== input.candidate.attempt
  ) {
    return false;
  }

  const existingIdentity = screenshotBaselineIdentity(input.existingBaseline);
  // An existing manifest without a trustworthy run identity may be newer than
  // the candidate. Preserve it rather than allowing a delayed run to replace
  // unknown data; an absent baseline is represented by undefined.
  if (input.existingBaseline !== undefined && existingIdentity === undefined) {
    return false;
  }
  return (
    existingIdentity === undefined || compareRunRecency(input.candidate, existingIdentity) <= 0
  );
}

function screenshotBaselineIdentity(value: unknown): { attempt: number; id: string } | undefined {
  if (!isScreenshotManifest(value)) return undefined;
  if (typeof value.id !== "string" || !/^\d+$/.test(value.id)) return undefined;
  if (typeof value.attempt !== "number") return undefined;
  return { attempt: value.attempt, id: value.id };
}

function compareRunRecency(
  left: { attempt: number; id: string },
  right: { attempt: number; id: string },
): number {
  const leftId = BigInt(left.id);
  const rightId = BigInt(right.id);
  if (leftId !== rightId) return leftId > rightId ? -1 : 1;
  return right.attempt - left.attempt;
}

export function renderPlaywrightDashboard(history: PlaywrightRun[]): string {
  const data = JSON.stringify(history).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <title>Playwright · Rakazo</title>
  <style>
    ${SHARED_PAGE_STYLES}
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top, #312e81 0, #09090b 34rem); }
    main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 64px 0; }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 20px; }
    .card, .table-wrap { border: 1px solid rgba(113, 113, 122, 0.38); border-radius: 18px; background: rgba(9, 9, 11, 0.78); box-shadow: 0 24px 80px rgba(0, 0, 0, 0.28); backdrop-filter: blur(16px); }
    .card { padding: 20px; }
    .label { color: #a1a1aa; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
    .value { display: block; margin-top: 8px; font-size: 1.5rem; font-weight: 700; }
    .table-wrap { overflow: hidden; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 16px 18px; border-bottom: 1px solid rgba(63, 63, 70, 0.72); text-align: left; vertical-align: middle; }
    th { color: #a1a1aa; font-size: 0.7rem; letter-spacing: 0.1em; text-transform: uppercase; }
    tbody tr:last-child td { border-bottom: 0; }
    tbody tr:hover { background: rgba(46, 16, 101, 0.32); }
    .status { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; text-transform: capitalize; }
    .status::before { width: 9px; height: 9px; border-radius: 50%; background: #f59e0b; content: ""; box-shadow: 0 0 18px currentColor; }
    .status.success { color: #4ade80; }
    .status.success::before { background: #4ade80; }
    .status.failure, .status.cancelled { color: #fb7185; }
    .status.failure::before, .status.cancelled::before { background: #fb7185; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .links { display: flex; gap: 14px; white-space: nowrap; }
    .links a { color: #c4b5fd; text-decoration: none; }
    .links a:hover { text-decoration: underline; }
    .empty { padding: 56px 24px; color: #a1a1aa; text-align: center; }
    footer { margin-top: 18px; color: #71717a; font-size: 0.8rem; text-align: right; }
    @media (max-width: 760px) {
      main { padding: 36px 0; }
      header { align-items: start; flex-direction: column; }
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .table-wrap { overflow-x: auto; }
      table { min-width: 880px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <p class="eyebrow">Rakazo · browser checks</p>
        <h1>Playwright</h1>
        <p class="subtitle">Persistent visual evidence and results from the emulated end-to-end suite.</p>
      </div>
      <div class="actions">
        <a class="button" href="#" id="latest-screenshots">Latest screenshots</a>
        <a class="button" href="#" id="latest-report">Latest report</a>
        <a class="button" href="https://github.com/elie222/rakazo/actions">GitHub Actions</a>
      </div>
    </header>

    <section class="summary" id="summary"></section>
    <section class="table-wrap">
      <table>
        <thead>
          <tr><th>Result</th><th>Run</th><th>Commit</th><th>Trigger</th><th>Screenshots</th><th>Published</th><th>Links</th></tr>
        </thead>
        <tbody id="runs"></tbody>
      </table>
      <div class="empty" id="empty" hidden>No Playwright runs have been published yet.</div>
    </section>
    <footer id="generated-at"></footer>
  </main>
  <script>
    const history = ${data};
    const runs = document.querySelector("#runs");
    const empty = document.querySelector("#empty");
    const summary = document.querySelector("#summary");
    const generatedAt = document.querySelector("#generated-at");
    const latestReport = document.querySelector("#latest-report");
    const latestScreenshots = document.querySelector("#latest-screenshots");
    const latestWithReport = history.find((run) => run.reportUrl);

    if (history.length === 0) {
      empty.hidden = false;
      latestReport.hidden = true;
      latestScreenshots.hidden = true;
    } else {
      if (latestWithReport) {
        latestReport.href = latestWithReport.reportUrl;
      } else {
        latestReport.hidden = true;
      }
      latestScreenshots.href = history[0].screenshotsUrl;
    }

    const latest = history[0];
    const recent = history.slice(0, 10);
    const recentPassing = recent.filter((run) => run.result === "success").length;
    const cards = [
      ["Latest result", latest?.result ?? "No runs"],
      ["Latest screenshots", latest ? String(latest.screenshotCount) : "—"],
      ["Recent pass rate", recent.length ? Math.round((recentPassing / recent.length) * 100) + "%" : "—"],
      ["Stored runs", String(history.length)],
    ];

    for (const [label, value] of cards) {
      const card = document.createElement("article");
      card.className = "card";
      const labelElement = document.createElement("span");
      labelElement.className = "label";
      labelElement.textContent = label;
      const valueElement = document.createElement("span");
      valueElement.className = "value";
      valueElement.textContent = value;
      card.append(labelElement, valueElement);
      summary.append(card);
    }

    for (const run of history) {
      const row = document.createElement("tr");
      const result = document.createElement("td");
      const status = document.createElement("span");
      const knownStatus = ["success", "failure", "cancelled"].includes(run.result) ? run.result : "other";
      status.className = "status " + knownStatus;
      status.textContent = run.result;
      result.append(status);

      const runNumber = document.createElement("td");
      runNumber.textContent = "#" + run.runNumber + " · attempt " + run.attempt;
      const commit = document.createElement("td");
      commit.className = "mono";
      commit.textContent = run.sha.slice(0, 7);
      const event = document.createElement("td");
      event.textContent = run.pullRequestNumber
        ? "PR #" + run.pullRequestNumber + " · " + run.branch
        : run.event + " · " + run.branch;
      const screenshotCount = document.createElement("td");
      screenshotCount.textContent = String(run.screenshotCount);
      const published = document.createElement("td");
      published.textContent = new Date(run.createdAt).toLocaleString();
      const links = document.createElement("td");
      const linkList = document.createElement("div");
      linkList.className = "links";
      const screenshots = document.createElement("a");
      screenshots.href = run.screenshotsUrl;
      screenshots.textContent = "Screenshots";
      const actions = document.createElement("a");
      actions.href = run.runUrl;
      actions.textContent = "Actions";
      linkList.append(screenshots);
      if (run.reportUrl) {
        const report = document.createElement("a");
        report.href = run.reportUrl;
        report.textContent = "Report";
        linkList.append(report);
      }
      if (run.pullRequestUrl) {
        const pullRequest = document.createElement("a");
        pullRequest.href = run.pullRequestUrl;
        pullRequest.textContent = "PR";
        linkList.append(pullRequest);
      }
      linkList.append(actions);
      links.append(linkList);

      row.append(result, runNumber, commit, event, screenshotCount, published, links);
      runs.append(row);
    }

    generatedAt.textContent = latest
      ? "Latest result published " + new Date(latest.createdAt).toLocaleString()
      : "Waiting for the first published run";
  </script>
</body>
</html>`;
}

export function renderScreenshotGallery(input: {
  baselineAvailable: boolean;
  createdAt: string;
  dashboardUrl: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  reportUrl?: string;
  result: string;
  runUrl: string;
  screenshots: PlaywrightScreenshot[];
  screenshotsUrl: string;
  sha: string;
}): string {
  return renderGalleryPage({ ...input, presentation: "review" });
}

export function renderMobileScreenshotGallery(input: {
  createdAt: string;
  runUrl: string;
  screenshots: MobileScreenshot[];
  screenshotsUrl: string;
  sha: string;
}): string {
  return renderGalleryPage({ ...input, presentation: "mobile" });
}

type GalleryInput =
  | ({
      presentation: "review";
    } & Parameters<typeof renderScreenshotGallery>[0])
  | {
      createdAt: string;
      presentation: "mobile";
      runUrl: string;
      screenshots: MobileScreenshot[];
      screenshotsUrl: string;
      sha: string;
    };

function renderGalleryPage(input: GalleryInput): string {
  const mobile = input.presentation === "mobile";
  const galleryBaseUrl = new URL(".", input.screenshotsUrl);
  const reviewScreenshots = mobile ? [] : input.screenshots;
  const counts = {
    changed: reviewScreenshots.filter((screenshot) => screenshot.comparison === "changed").length,
    failed: reviewScreenshots.filter((screenshot) => screenshot.captureType === "failure").length,
    new: reviewScreenshots.filter((screenshot) => screenshot.comparison === "new").length,
  };
  const reviewCount = reviewScreenshots.filter(
    (screenshot) =>
      screenshot.captureType === "failure" ||
      screenshot.comparison === "changed" ||
      screenshot.comparison === "new",
  ).length;
  const defaultFilter = mobile
    ? "all"
    : !input.baselineAvailable
      ? "all"
      : counts.new > 0
        ? "new"
        : "review";
  const screenshots = (
    mobile
      ? input.screenshots.map((screenshot, index) =>
          renderGalleryFigure(screenshot, index, galleryBaseUrl),
        )
      : input.screenshots.map((screenshot, index) =>
          renderGalleryFigure(screenshot, index, galleryBaseUrl, screenshot),
        )
  ).join("");
  const filterScript = mobile
    ? ""
    : `
    const figures = Array.from(document.querySelectorAll("figure"));
    const filters = Array.from(document.querySelectorAll(".filter"));
    const filterEmpty = document.querySelector(".filter-empty");

    function setFilter(filter) {
      let visible = 0;
      for (const figure of figures) {
        const show = filter === "all" ||
          (filter === "review" && (figure.dataset.capture === "failure" || ["new", "changed"].includes(figure.dataset.comparison))) ||
          (filter === "failed" && figure.dataset.capture === "failure") ||
          filter === figure.dataset.capture || filter === figure.dataset.comparison;
        figure.hidden = !show;
        if (show) visible += 1;
      }
      for (const button of filters) {
        button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
      }
      if (filterEmpty) filterEmpty.hidden = visible !== 0;
    }

    setFilter(${JSON.stringify(defaultFilter)});
    for (const filter of filters) {
      filter.addEventListener("click", () => setFilter(filter.dataset.filter));
    }`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <title>${mobile ? "Android screenshots" : "Run screenshots"} · Rakazo</title>
  <style>
    ${SHARED_PAGE_STYLES}
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top, #312e81 0, #09090b 36rem); }
    main { width: min(1440px, calc(100% - 32px)); margin: 0 auto; padding: 56px 0 80px; }
    header { margin-bottom: 30px; }
    .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 28px; }
    .filters { display: flex; flex-wrap: wrap; gap: 8px; margin: -10px 0 24px; }
    .filter { padding: 8px 12px; border: 1px solid rgba(113, 113, 122, 0.45); border-radius: 999px; color: #d4d4d8; background: rgba(9, 9, 11, 0.7); cursor: pointer; }
    .filter:hover { border-color: #a78bfa; }
    .filter[aria-pressed="true"] { border-color: #8b5cf6; color: #fff; background: #4c1d95; }
    .filter:disabled { opacity: 0.45; cursor: not-allowed; }
    .meta { display: flex; flex-wrap: wrap; gap: 10px; }
    .pill { padding: 8px 12px; border: 1px solid rgba(113, 113, 122, 0.45); border-radius: 999px; color: #d4d4d8; background: rgba(9, 9, 11, 0.7); }
    .view-options { display: inline-flex; flex: 0 0 auto; gap: 4px; padding: 4px; border: 1px solid rgba(113, 113, 122, 0.45); border-radius: 10px; background: rgba(9, 9, 11, 0.7); }
    .view-option { display: grid; width: 34px; height: 34px; padding: 0; border: 0; border-radius: 7px; place-items: center; color: #a1a1aa; background: transparent; cursor: pointer; }
    .view-option:hover { color: #fafafa; background: rgba(63, 63, 70, 0.72); }
    .view-option[aria-pressed="true"] { color: #fafafa; background: #5b21b6; }
    .view-option:focus-visible { outline: 2px solid #c4b5fd; outline-offset: 2px; }
    .view-option svg { width: 18px; height: 18px; }
    .gallery { display: grid; grid-template-columns: repeat(var(--gallery-columns, 1), minmax(0, 1fr)); gap: 22px; }
    figure { margin: 0; overflow: hidden; border: 1px solid rgba(113, 113, 122, 0.42); border-radius: 18px; background: rgba(9, 9, 11, 0.84); box-shadow: 0 24px 80px rgba(0, 0, 0, 0.28); }
    figure > a { display: grid; min-height: 300px; place-items: center; padding: 12px; background: #18181b; }
    img { display: block; width: 100%; max-height: 820px; object-fit: contain; object-position: top; border-radius: 10px; }
    figcaption { display: flex; align-items: center; gap: 14px; padding: 16px 18px; border-top: 1px solid rgba(63, 63, 70, 0.72); }
    .caption-copy { min-width: 0; }
    figcaption strong, figcaption small { display: block; }
    figcaption strong { text-transform: capitalize; }
    figcaption small { margin-top: 4px; overflow: hidden; color: #71717a; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
    .badges { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
    .badge { display: inline-flex; padding: 3px 7px; border-radius: 999px; font-size: 0.66rem; font-weight: 800; letter-spacing: 0.08em; }
    .badge.failure { color: #fecdd3; background: #881337; }
    .badge.checkpoint { color: #ddd6fe; background: #4c1d95; }
    .badge.new { color: #bbf7d0; background: #14532d; }
    .badge.changed { color: #fde68a; background: #713f12; }
    .badge.unchanged, .badge.unavailable { color: #d4d4d8; background: #3f3f46; }
    .number { display: grid; width: 36px; height: 36px; flex: 0 0 auto; place-items: center; border-radius: 50%; color: #ddd6fe; background: #2e1065; font-size: 0.78rem; font-weight: 700; }
    .empty { padding: 80px 24px; border: 1px solid rgba(113, 113, 122, 0.38); border-radius: 18px; color: #a1a1aa; text-align: center; background: rgba(9, 9, 11, 0.78); }
    .filter-empty { margin-top: 20px; }
    @media (max-width: 900px) {
      header { align-items: start; flex-direction: column; }
      .toolbar { align-items: start; flex-direction: column; }
      .view-options { display: none; }
      .gallery { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <p class="eyebrow">Rakazo · visual review</p>
        <h1>${mobile ? "Android screenshots" : input.pullRequestNumber ? `PR #${input.pullRequestNumber} screenshots` : "Run screenshots"}</h1>
        ${mobile ? "" : '<p class="subtitle">Review intentional checkpoints separately from automatic failure captures.</p>'}
      </div>
      <div class="actions">
        ${!mobile && input.reportUrl ? `<a class="button" href="${escapeHtml(input.reportUrl)}">Full report</a>` : ""}
        ${!mobile && input.pullRequestUrl ? `<a class="button" href="${escapeHtml(input.pullRequestUrl)}">PR #${input.pullRequestNumber}</a>` : ""}
        <a class="button" href="${escapeHtml(input.runUrl)}">GitHub Actions</a>
        ${mobile ? "" : `<a class="button" href="${escapeHtml(input.dashboardUrl)}">All runs</a>`}
      </div>
    </header>
    <div class="toolbar">
      <section class="meta">
        ${mobile ? "" : `<span class="pill">${escapeHtml(input.result)}</span>`}
        <span class="pill">${escapeHtml(input.sha.slice(0, 7))}</span>
        <span class="pill">${input.screenshots.length} screenshots</span>
        ${mobile ? "" : `<span class="pill">${input.baselineAvailable ? "Compared with latest successful main run" : "No comparable main baseline"}</span>`}
        <span class="pill">${escapeHtml(new Date(input.createdAt).toLocaleString("en-US", { timeZone: "UTC" }))} UTC</span>
      </section>
      ${
        screenshots
          ? `<div class="view-options" role="group" aria-label="Gallery columns">
        <button class="view-option" type="button" data-columns="1" aria-label="One column" aria-pressed="true" title="One column">
          <svg aria-hidden="true" viewBox="0 0 18 18"><rect x="3" y="2" width="12" height="14" rx="1.5" fill="currentColor" /></svg>
        </button>
        <button class="view-option" type="button" data-columns="2" aria-label="Two columns" aria-pressed="false" title="Two columns">
          <svg aria-hidden="true" viewBox="0 0 18 18"><rect x="1" y="2" width="7" height="14" rx="1.5" fill="currentColor" /><rect x="10" y="2" width="7" height="14" rx="1.5" fill="currentColor" /></svg>
        </button>
        <button class="view-option" type="button" data-columns="3" aria-label="Three columns" aria-pressed="false" title="Three columns">
          <svg aria-hidden="true" viewBox="0 0 18 18"><rect x="1" y="2" width="4" height="14" rx="1" fill="currentColor" /><rect x="7" y="2" width="4" height="14" rx="1" fill="currentColor" /><rect x="13" y="2" width="4" height="14" rx="1" fill="currentColor" /></svg>
        </button>
        <button class="view-option" type="button" data-columns="4" aria-label="Four columns" aria-pressed="false" title="Four columns">
          <svg aria-hidden="true" viewBox="0 0 18 18"><rect x="1" y="2" width="3" height="14" rx="1" fill="currentColor" /><rect x="5.3" y="2" width="3" height="14" rx="1" fill="currentColor" /><rect x="9.7" y="2" width="3" height="14" rx="1" fill="currentColor" /><rect x="14" y="2" width="3" height="14" rx="1" fill="currentColor" /></svg>
        </button>
      </div>`
          : ""
      }
    </div>
    ${
      screenshots && !mobile
        ? `<nav class="filters" aria-label="Screenshot filters">
      <button class="filter" type="button" data-filter="all" aria-pressed="${String(defaultFilter === "all")}">All (${input.screenshots.length})</button>
      <button class="filter" type="button" data-filter="review" aria-pressed="${String(defaultFilter === "review")}">Review changes (${reviewCount})</button>
      <button class="filter" type="button" data-filter="new" aria-pressed="${String(defaultFilter === "new")}" ${input.baselineAvailable ? "" : "disabled"}>New (${counts.new})</button>
      <button class="filter" type="button" data-filter="changed" aria-pressed="false" ${input.baselineAvailable ? "" : "disabled"}>Changed (${counts.changed})</button>
      <button class="filter" type="button" data-filter="failed" aria-pressed="false">Failed (${counts.failed})</button>
    </nav>`
        : ""
    }
    ${screenshots ? `<section class="gallery">${screenshots}</section>` : '<div class="empty">No screenshots were produced by this run.</div>'}
    ${screenshots && !mobile ? '<div class="empty filter-empty" hidden>No screenshots match this filter.</div>' : ""}
  </main>
  <script>
    const gallery = document.querySelector(".gallery");
    const viewOptions = Array.from(document.querySelectorAll(".view-option"));
    const storageKey = "rakazo-playwright-gallery-columns";

    function setGalleryColumns(value, persist = false) {
      if (!gallery || !["1", "2", "3", "4"].includes(value)) return;

      gallery.style.setProperty("--gallery-columns", value);
      for (const option of viewOptions) {
        option.setAttribute("aria-pressed", String(option.dataset.columns === value));
      }

      if (persist) {
        try {
          localStorage.setItem(storageKey, value);
        } catch {}
      }
    }

    let initialColumns = "1";
    try {
      initialColumns = localStorage.getItem(storageKey) || initialColumns;
    } catch {}
    setGalleryColumns(initialColumns);

    for (const option of viewOptions) {
      option.addEventListener("click", () => setGalleryColumns(option.dataset.columns, true));
    }

    ${filterScript}
  </script>
</body>
</html>`;
}

function renderGalleryFigure(
  screenshot: MobileScreenshot,
  index: number,
  galleryBaseUrl: URL,
  review?: Pick<PlaywrightScreenshot, "captureType" | "comparison" | "hash" | "testId">,
): string {
  const imageUrl = new URL(screenshot.fileName, galleryBaseUrl).toString();
  const badges = review
    ? [
        review.captureType === "failure"
          ? '<span class="badge failure">FAILED</span>'
          : '<span class="badge checkpoint">CHECKPOINT</span>',
        review.comparison === "new"
          ? '<span class="badge new">NEW</span>'
          : review.comparison === "changed"
            ? '<span class="badge changed">CHANGED</span>'
            : review.comparison === "unchanged"
              ? '<span class="badge unchanged">UNCHANGED</span>'
              : '<span class="badge unavailable">NO BASELINE</span>',
      ].join("")
    : "";

  return `
        <figure${review ? ` data-capture="${review.captureType}" data-comparison="${review.comparison}"` : ""}>
          <a href="${escapeHtml(imageUrl)}" target="_blank" rel="noreferrer">
            <img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(screenshot.title)}" loading="lazy" />
          </a>
          <figcaption>
            <span class="number">${String(index + 1).padStart(2, "0")}</span>
            <span class="caption-copy">
              ${badges ? `<span class="badges">${badges}</span>` : ""}
              <strong>${escapeHtml(screenshot.title)}</strong>
              ${review ? `<small>${review.captureType === "failure" ? "Automatic failure capture" : "Intentional test checkpoint"} · ${escapeHtml(review.testId)}</small>` : ""}
              <small title="${escapeHtml(screenshot.source)}">${escapeHtml(screenshot.source)}</small>
              ${review ? `<small>SHA-256 ${escapeHtml(review.hash.slice(0, 12))}</small>` : ""}
            </span>
          </figcaption>
        </figure>`;
}

function isPlaywrightRun(value: unknown): value is PlaywrightRun {
  if (!value || typeof value !== "object") return false;

  const run = value as Partial<PlaywrightRun>;
  return (
    typeof run.attempt === "number" &&
    typeof run.branch === "string" &&
    typeof run.createdAt === "string" &&
    typeof run.event === "string" &&
    typeof run.id === "string" &&
    /^\d+$/.test(run.id) &&
    (run.reportUrl === undefined || isHttpsUrl(run.reportUrl)) &&
    (run.pullRequestNumber === undefined ||
      (Number.isInteger(run.pullRequestNumber) && run.pullRequestNumber > 0)) &&
    (run.pullRequestUrl === undefined || isHttpsUrl(run.pullRequestUrl)) &&
    ((run.pullRequestNumber === undefined && run.pullRequestUrl === undefined) ||
      (run.pullRequestNumber !== undefined && run.pullRequestUrl !== undefined)) &&
    typeof run.result === "string" &&
    typeof run.runNumber === "number" &&
    isHttpsUrl(run.runUrl) &&
    typeof run.screenshotCount === "number" &&
    isHttpsUrl(run.screenshotsUrl) &&
    typeof run.sha === "string"
  );
}

function isScreenshotManifest(value: unknown): value is PlaywrightScreenshotManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<PlaywrightScreenshotManifest>;
  return (
    manifest.version === 1 &&
    Array.isArray(manifest.screenshots) &&
    manifest.screenshots.every((screenshot) => {
      if (!screenshot || typeof screenshot !== "object") return false;
      const candidate = screenshot as Partial<PlaywrightScreenshotMetadata>;
      return (
        (candidate.captureType === "checkpoint" || candidate.captureType === "failure") &&
        typeof candidate.hash === "string" &&
        /^[a-f0-9]{64}$/.test(candidate.hash) &&
        typeof candidate.source === "string" &&
        typeof candidate.testId === "string" &&
        typeof candidate.title === "string"
      );
    })
  );
}

function isHttpsUrl(value: unknown): value is string {
  return typeof value === "string" && URL.canParse(value) && new URL(value).protocol === "https:";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
