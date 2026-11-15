import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(
    path.resolve(import.meta.dirname, "../../../.github/workflows/model-catalog-bump.yml"),
    "utf8",
  ),
) as { jobs: { publish: { steps: Array<{ name?: string; run?: string }> } } };
const publishScript = (name: string) =>
  workflow.jobs.publish.steps.find((step) => step.name === name)!.run!;
const applyScript = publishScript("Apply bump patch");

describe("model catalog artifact boundary", () => {
  let root: string;
  let artifact: string;
  const manifest = "packages/adapters/package.json";
  function git(...args: string[]) {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  }
  function apply() {
    return spawnSync("bash", ["-c", applyScript], {
      cwd: root,
      env: { ...process.env, BUMP_DIR: artifact },
      encoding: "utf8",
    });
  }
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "rakazo-catalog-artifact-"));
    artifact = path.join(root, "artifact");
    mkdirSync(path.join(root, "packages/adapters"), { recursive: true });
    writeFileSync(path.join(root, manifest), '{"version":"1"}\n');
    writeFileSync(path.join(root, "pnpm-lock.yaml"), "version: 1\n");
    git("init", "-q");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    mkdirSync(artifact);
    writeFileSync(path.join(root, manifest), '{"version":"2"}\n');
    writeFileSync(path.join(root, "pnpm-lock.yaml"), "version: 2\n");
    writeFileSync(path.join(artifact, "bump.patch"), git("diff"));
    git("checkout", "--", manifest, "pnpm-lock.yaml");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("stages the permitted regular files and ignores paths outside the allowlist", () => {
    writeFileSync(path.join(root, "unexpected-script"), "untrusted\n");
    git("add", "unexpected-script");
    writeFileSync(
      path.join(artifact, "bump.patch"),
      readFileSync(path.join(artifact, "bump.patch"), "utf8") + git("diff", "--cached"),
    );
    git("reset", "-q");
    rmSync(path.join(root, "unexpected-script"));
    expect(apply().status).toBe(0);
    expect(git("diff", "--cached", "--name-only").trim().split("\n")).toEqual([
      manifest,
      "pnpm-lock.yaml",
    ]);
    expect(git("show", `:${manifest}`)).toBe('{"version":"2"}\n');
    expect(git("show", ":pnpm-lock.yaml")).toBe("version: 2\n");
    expect(git("status", "--porcelain", "--", "unexpected-script")).toBe("");
  });

  it("rejects additional artifact entries before touching the checkout", () => {
    const originalConfig = readFileSync(path.join(root, ".git/config"), "utf8");
    mkdirSync(path.join(artifact, ".git"));
    writeFileSync(path.join(artifact, ".git/config"), "[core]\nfsmonitor=untrusted\n");
    expect(apply().status).not.toBe(0);
    expect(readFileSync(path.join(root, ".git/config"), "utf8")).toBe(originalConfig);
    expect(git("diff", "--cached")).toBe("");
  });

  it("rejects a symlink in place of the patch", () => {
    rmSync(path.join(artifact, "bump.patch"));
    symlinkSync(path.join(root, "pnpm-lock.yaml"), path.join(artifact, "bump.patch"));
    expect(apply().status).not.toBe(0);
    expect(git("diff", "--cached")).toBe("");
  });

  it("rejects a patch that replaces a permitted file with a symlink", () => {
    rmSync(path.join(root, manifest));
    symlinkSync("../../pnpm-lock.yaml", path.join(root, manifest));
    writeFileSync(path.join(artifact, "bump.patch"), git("diff"));
    git("checkout", "--", manifest);
    expect(apply().status).not.toBe(0);
  });
});

describe("model catalog bump PR lookup", () => {
  const branch = "deps/pi-catalog-ai-1.4.0-core-1.4.0";
  let root: string;
  const remoteBranches = () =>
    execFileSync("git", ["branch", "--format=%(refname:short)"], {
      cwd: path.join(root, "origin.git"),
      encoding: "utf8",
    }).trim();
  function publish(
    openPrs: Array<{ number: number; headRefName: string; isCrossRepository: boolean }>,
  ) {
    writeFileSync(path.join(root, "prs.json"), JSON.stringify(openPrs));
    const result = spawnSync("bash", ["-c", publishScript("Push branch and open PR")], {
      cwd: path.join(root, "checkout"),
      env: {
        ...process.env,
        PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
        GH_LOG: path.join(root, "gh.log"),
        GH_PRS: path.join(root, "prs.json"),
        OLD_AI: "1.3.0",
        NEW_AI: "1.4.0",
        OLD_CORE: "1.3.0",
        NEW_CORE: "1.4.0",
      },
      encoding: "utf8",
    });
    const calls = readFileSync(path.join(root, "gh.log"), "utf8").trim().split("\n");
    return { status: result.status, calls: calls.filter((call) => !call.startsWith("pr list")) };
  }
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "rakazo-catalog-publish-"));
    mkdirSync(path.join(root, "bin"));
    // Like the real CLI, --head also matches fork PRs from a branch with the same name, and only
    // the --json fields are returned.
    writeFileSync(
      path.join(root, "bin/gh"),
      `#!/usr/bin/env bash
echo "\${*:1:3}" >> "$GH_LOG"
[ "$1 $2" = "pr list" ] || exit 0
head="" fields="" query="."
while [ $# -gt 0 ]; do
  case "$1" in --head) head="$2"; shift ;; --json) fields="$2"; shift ;; --jq) query="$2"; shift ;; esac
  shift
done
jq --arg head "$head" --arg fields "$fields" '[.[] | select($head == "" or .headRefName == $head)
  | with_entries(select(.key as $key | $fields | split(",") | index($key)))]' "$GH_PRS" |
  jq -r "$query" | grep -vx null || true
`,
    );
    chmodSync(path.join(root, "bin/gh"), 0o755);
    const checkout = path.join(root, "checkout");
    execFileSync("git", ["init", "-q", "--bare", path.join(root, "origin.git")]);
    execFileSync("git", ["init", "-q", checkout]);
    execFileSync("git", ["remote", "add", "origin", path.join(root, "origin.git")], {
      cwd: checkout,
    });
    writeFileSync(path.join(checkout, "pnpm-lock.yaml"), "version: 2\n");
    execFileSync("git", ["add", "."], { cwd: checkout });
    writeFileSync(path.join(root, "gh.log"), "");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("ignores fork PRs that reuse the bump branch names", () => {
    const result = publish([
      { number: 4242, headRefName: branch, isCrossRepository: true },
      { number: 4243, headRefName: "deps/pi-catalog-contributor-work", isCrossRepository: true },
      { number: 7, headRefName: "deps/pi-catalog-ai-1.3.0-core-1.3.0", isCrossRepository: false },
      { number: 8, headRefName: "deps/weekly-dependencies-1", isCrossRepository: false },
    ]);
    expect(result.status).toBe(0);
    expect(remoteBranches()).toBe(branch);
    expect(result.calls).toEqual(["auth setup-git", "pr close 7", "pr create --title"]);
  });

  it("leaves its own open PR for the same versions in place", () => {
    const result = publish([{ number: 7, headRefName: branch, isCrossRepository: false }]);
    expect(result.status).toBe(0);
    expect(remoteBranches()).toBe("");
    expect(result.calls).toEqual([]);
  });
});
