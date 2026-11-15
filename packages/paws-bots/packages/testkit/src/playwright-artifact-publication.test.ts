// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Shell and GitHub expressions are literal workflow fixtures.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const extractor = path.join(repoRoot, "scripts/extract-playwright-artifacts.py");
const workflow = readFileSync(
  path.join(repoRoot, ".github/workflows/publish-playwright-report.yml"),
  "utf8",
);
const temporaryDirectories: string[] = [];
const screenshotImage = new PNG({ width: 1, height: 1 });
screenshotImage.data = Buffer.from([23, 45, 67, 255]);
const screenshot = PNG.sync.write(screenshotImage);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Allocate a fixture directory that afterEach removes, including failed test runs. */
function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "playwright-publication-"));
  temporaryDirectories.push(directory);
  return directory;
}

function write(file: string, content: string | Buffer) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Create an offline ZIP fixture with optional file types keyed by entry name. */
function makeArchive(
  root: string,
  entries: Record<string, string | Buffer>,
  modes: Record<string, number> = {},
) {
  const archive = path.join(root, "artifact.zip");
  execFileSync(
    "python3",
    [
      "-c",
      `import base64, json, sys, zipfile
modes = json.loads(sys.argv[2])
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    for name, data in json.load(sys.stdin).items():
        entry = zipfile.ZipInfo(name)
        entry.create_system = 3
        entry.external_attr = modes.get(name, 0o100644) << 16
        archive.writestr(entry, base64.b64decode(data))
`,
      archive,
      JSON.stringify(modes),
    ],
    {
      input: JSON.stringify(
        Object.fromEntries(
          Object.entries(entries).map(([name, data]) => [
            name,
            Buffer.from(data).toString("base64"),
          ]),
        ),
      ),
    },
  );
  return archive;
}

describe("Playwright artifact publication boundary", () => {
  // GitHub's Ubuntu runner provides bash and jq; Windows does not necessarily provide either.
  it.skipIf(process.platform === "win32")(
    "reads the triggering attempt across every jobs page",
    () => {
      const root = temporaryDirectory();
      const output = path.join(root, "output");
      const step = workflow
        .split("      - name: Read Playwright job result\n")[1]
        ?.split("\n  publish:\n")[0];
      expect(step).toContain("RUN_ATTEMPT: ${{ github.event.workflow_run.run_attempt }}");
      const script = step?.split("        run: |\n")[1]?.replace(/^ {10}/gm, "");
      expect(script).toBeTruthy();
      const mock = `gh() {
  if [[ "$*" == *"/attempts/2/jobs"* && "$*" == *"--paginate"* && "$*" == *"--slurp"* ]]; then
    printf '%s\\n' '[{"jobs":[{"name":"Other","conclusion":"success"}]},{"jobs":[{"name":"Web E2E / Web E2E","conclusion":"failure"}]}]'
  else
    printf '%s\\n' success
  fi
}
${script}`;
      execFileSync("bash", ["-eo", "pipefail", "-c", mock], {
        env: {
          ...process.env,
          GITHUB_REPOSITORY: "example/repo",
          RUN_ID: "123",
          RUN_ATTEMPT: "2",
          GITHUB_OUTPUT: output,
        },
      });
      expect(readFileSync(output, "utf8")).toBe("job_result=failure\nresult=failure\n");
    },
  );

  it("keeps extraction and explicit report inputs outside the trusted checkout", () => {
    expect(workflow).not.toContain("actions/download-artifact@");
    expect(workflow).toContain(
      'gh api "repos/${GITHUB_REPOSITORY}/actions/artifacts/${ARTIFACT_ID}/zip" > "$RUNNER_TEMP/playwright-artifacts.zip"',
    );
    expect(workflow).toContain(
      'python3 scripts/extract-playwright-artifacts.py \\\n            "$RUNNER_TEMP/playwright-artifacts.zip" "$RUNNER_TEMP/playwright-artifacts"',
    );
    expect(workflow).toContain(
      "PLAYWRIGHT_REPORT_DIR: ${{ runner.temp }}/playwright-artifacts/playwright-report",
    );
    expect(workflow).toContain(
      "PLAYWRIGHT_TEST_RESULTS_DIR: ${{ runner.temp }}/playwright-artifacts/apps/web/test-results",
    );
    expect(workflow).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("run: bash scripts/publish-playwright-report.sh");
    expect(workflow).not.toContain("working-directory:");
  });

  it.each([
    ["../escape.txt", 0o100644],
    ["/escape.txt", 0o100644],
    ["nested\\..\\escape.txt", 0o100644],
    ["apps/web/test-results/link", 0o120777],
  ])("rejects unsafe ZIP entry %s before extracting any data", (name, mode) => {
    const root = temporaryDirectory();
    const archive = makeArchive(
      root,
      { "playwright-report/index.html": "valid", [name]: "unsafe" },
      { [name]: mode },
    );
    const destination = path.join(root, "artifacts");
    expect(() =>
      execFileSync("python3", [extractor, archive, destination], { stdio: "pipe" }),
    ).toThrow();
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(path.join(root, "escape.txt"))).toBe(false);
  });

  it("refuses an existing destination, including a filesystem link", () => {
    const root = temporaryDirectory();
    const destination = path.join(root, "artifacts");
    symlinkSync(root, destination, "dir");
    const archive = makeArchive(root, { "overwrite.txt": "unsafe" });
    expect(() =>
      execFileSync("python3", [extractor, archive, destination], { stdio: "pipe" }),
    ).toThrow();
    expect(existsSync(path.join(root, "overwrite.txt"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "links the immutable gallery on every current matching PR",
    () => {
      const root = temporaryDirectory();
      const calls = path.join(root, "comments");
      write(path.join(root, ".tmp/playwright-dashboard/screenshots/review.json"), "{}");
      const step = workflow
        .split("      - name: Link screenshot gallery from pull request\n")[1]
        ?.split("\n  screenshot-source:")[0];
      const script = step?.split("        run: |\n")[1]?.replace(/^ {10}/gm, "");
      expect(script).toBeTruthy();
      const mock = `gh() {
  case "$*" in
    *"/files?"*) printf '%s\\n' 'apps/web/src/example.tsx' ;;
    *"--method POST"*) printf '%s %s\\n' "$*" "$(cat)" >> "$COMMENT_CALLS" ;;
    *"/comments?"*) printf '%s\\n' '[[]]' ;;
    *"/pulls/3"*) printf '%s\\n' 'open outdated' ;;
    *"/pulls/"*) printf 'open %s\\n' "$SHA" ;;
    *) return 1 ;;
  esac
}
pnpm() { printf 'Gallery: %s\\n' "$PLAYWRIGHT_GALLERY_URL"; }
${script}`;
      execFileSync("bash", ["-eo", "pipefail", "-c", mock], {
        env: {
          ...process.env,
          GITHUB_WORKSPACE: root,
          GITHUB_REPOSITORY: "example/repo",
          PLAYWRIGHT_PUBLIC_BASE_URL: "https://reports.example.invalid/playwright",
          PRS: "[1,2,3]",
          SHA: "a".repeat(40),
          RUN_KEY: "200-1",
          RUN_URL: "https://github.com/example/repo/actions/runs/200",
          COMMENT_CALLS: calls,
        },
        stdio: "pipe",
      });
      const published = readFileSync(calls, "utf8");
      expect(published).toContain("/issues/1/comments");
      expect(published).toContain("/issues/2/comments");
      expect(published).not.toContain("/issues/3/comments");
      expect(published).toContain(
        "https://reports.example.invalid/playwright/runs/200-1/screenshots/index.html",
      );
    },
  );

  it.each(["pull_request", "schedule", "timed_out"])(
    "publishes %s through trusted code with fake storage and credentials",
    (scenario) => {
      const vitestPath = path.join(repoRoot, "node_modules/vitest/vitest.mjs");
      const originalVitest = realpathSync(vitestPath);
      const root = temporaryDirectory();
      const checkout = path.join(root, "checkout");
      const runnerTemp = path.join(root, "runner-temp");
      const artifacts = path.join(runnerTemp, "playwright-artifacts");
      const hasArtifact = scenario !== "timed_out";
      const isPr = scenario !== "schedule";
      const trustedFiles = [
        "package.json",
        "scripts/publish-playwright-report.sh",
        "packages/testkit/src/cli/generate-playwright-report-dashboard.ts",
        "packages/testkit/src/cli/build-playwright-pr-screenshot-comment.ts",
        "packages/testkit/src/playwright-report-dashboard.ts",
        "packages/testkit/src/playwright-pr-screenshot-comment.ts",
        "packages/testkit/src/screenshot-commit-marker.json",
        "packages/testkit/src/png-validation.ts",
      ];
      for (const file of trustedFiles) {
        write(path.join(checkout, file), readFileSync(path.join(repoRoot, file)));
      }
      if (hasArtifact) {
        const replacements = Object.fromEntries(
          [
            ...trustedFiles,
            "tsconfig.json",
            ".npmrc",
            "node_modules/tsx/package.json",
            ".tmp/playwright-dashboard/screenshots/review.json",
          ].map((file) => [file, "untrusted replacement"]),
        );
        replacements["scripts/publish-playwright-report.sh"] =
          'printf "%s" "$AWS_SECRET_ACCESS_KEY" > "$ATTACK_MARKER"; exit 90';
        replacements["packages/testkit/src/cli/build-playwright-pr-screenshot-comment.ts"] =
          'import { writeFileSync } from "node:fs"; writeFileSync(process.env.ATTACK_MARKER, process.env.GH_TOKEN);';
        const archive = makeArchive(root, {
          ...replacements,
          "playwright-report/index.html": "<html>Example report</html>",
          "apps/web/test-results/example-chromium/checkpoint.png": screenshot,
        });
        execFileSync("python3", [extractor, archive, artifacts]);
        expect(readFileSync(path.join(artifacts, "package.json"), "utf8")).toBe(
          "untrusted replacement",
        );
      }
      // Dependencies are trusted and remain outside the extraction tree.
      for (const directory of ["node_modules", "packages/testkit/node_modules"]) {
        symlinkSync(path.join(repoRoot, directory), path.join(checkout, directory), "dir");
      }
      const bin = path.join(root, "bin");
      write(
        path.join(bin, "pnpm"),
        '#!/bin/sh\n[ "$1" = exec ] && [ "$2" = tsx ] || exit 1\nshift 2\nexec "$TEST_NODE" --import tsx "$@"\n',
      );
      execFileSync("chmod", ["+x", path.join(bin, "pnpm")]);
      write(
        path.join(bin, "aws"),
        `#!/usr/bin/env python3
import os, pathlib, shutil, sys
operation, source, destination = sys.argv[2:5]
if source.startswith("s3://"):
    print("NoSuchKey 404", file=sys.stderr)
    sys.exit(1)
target = pathlib.Path(os.environ["FAKE_STORAGE"]) / destination.removeprefix("s3://example-bucket/")
target.parent.mkdir(parents=True, exist_ok=True)
if operation == "sync":
    shutil.copytree(source, target, dirs_exist_ok=True)
else:
    shutil.copyfile(source, target)
`,
      );
      execFileSync("chmod", ["+x", path.join(bin, "aws")]);
      const storage = path.join(root, "published");
      const env = {
        PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
        GITHUB_WORKSPACE: checkout,
        GITHUB_OUTPUT: path.join(root, "outputs"),
        AWS_ACCESS_KEY_ID: "fake-access-key",
        AWS_SECRET_ACCESS_KEY: "fake-storage-secret",
        S3_BUCKET: "example-bucket",
        S3_ENDPOINT: "https://storage.example.invalid",
        PLAYWRIGHT_PUBLIC_BASE_URL: "https://reports.example.invalid/playwright",
        PLAYWRIGHT_RESULT: scenario === "timed_out" ? "failure" : "success",
        PLAYWRIGHT_RUN_ATTEMPT: "1",
        PLAYWRIGHT_RUN_ID: "200",
        PLAYWRIGHT_RUN_NUMBER: "10",
        PLAYWRIGHT_RUN_URL: "https://example.invalid/actions/runs/200",
        PLAYWRIGHT_SHA: "a".repeat(40),
        PLAYWRIGHT_EVENT: isPr ? "pull_request" : scenario,
        PLAYWRIGHT_BRANCH: isPr ? "example-change" : "main",
        PLAYWRIGHT_PR_NUMBER: isPr ? "42" : "",
        PLAYWRIGHT_REPOSITORY_URL: "https://example.invalid/project",
        PLAYWRIGHT_PUBLISH_REPORT: String(!isPr),
        PLAYWRIGHT_REPORT_DIR: path.join(artifacts, "playwright-report"),
        PLAYWRIGHT_TEST_RESULTS_DIR: path.join(artifacts, "apps/web/test-results"),
        FAKE_STORAGE: storage,
        TEST_NODE: process.execPath,
        ATTACK_MARKER: path.join(root, "executed-untrusted-code"),
      };
      execFileSync("bash", ["scripts/publish-playwright-report.sh"], {
        cwd: checkout,
        env,
        stdio: "pipe",
      });
      expect(realpathSync(vitestPath)).toBe(originalVitest);
      const published = path.join(storage, "playwright");
      const run = path.join(published, "runs/200-1");
      expect(existsSync(path.join(run, "report/index.html"))).toBe(!isPr);
      const manifest = JSON.parse(
        readFileSync(path.join(run, "screenshots/manifest.json"), "utf8"),
      );
      expect(manifest.screenshots).toHaveLength(hasArtifact ? 1 : 0);
      if (hasArtifact) {
        expect(readFileSync(path.join(run, "screenshots/images/001-checkpoint.png"))).toEqual(
          screenshot,
        );
      }
      if (isPr) {
        expect(readFileSync(env.GITHUB_OUTPUT, "utf8")).toContain("latest_pr_run=true");
        const changedPaths = path.join(root, "changed-paths.txt");
        write(changedPaths, "apps/web/src/example.tsx\n");
        const comment = execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "packages/testkit/src/cli/build-playwright-pr-screenshot-comment.ts",
            path.join(checkout, ".tmp/playwright-dashboard/screenshots/review.json"),
            changedPaths,
          ],
          {
            cwd: checkout,
            encoding: "utf8",
            env: {
              ...env,
              GH_TOKEN: "fake-comment-token",
              PLAYWRIGHT_GALLERY_URL:
                "https://reports.example.invalid/playwright/prs/42/index.html",
              PLAYWRIGHT_DASHBOARD_URL: "https://reports.example.invalid/playwright/index.html",
            },
          },
        );
        expect(comment).toContain("<!-- rakazo-playwright-screenshots -->");
        expect(existsSync(path.join(published, "prs/42/index.html"))).toBe(true);
      }
      expect(existsSync(env.ATTACK_MARKER)).toBe(false);
      for (const file of trustedFiles) {
        expect(readFileSync(path.join(checkout, file))).toEqual(
          readFileSync(path.join(repoRoot, file)),
        );
      }
    },
  );
});
