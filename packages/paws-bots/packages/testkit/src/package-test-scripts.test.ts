import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const vitest = path.join(repoRoot, "node_modules/vitest/vitest.mjs");

describe("package test scripts", () => {
  it.each(["apps/worker", "packages/ui-tokens", "packages/ui-web"])(
    "%s discovers its own tests from the package directory",
    (directory) => {
      const cwd = path.join(repoRoot, directory);
      const manifest = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
      const [command, mode, ...args] = manifest.scripts.test.split(" ");
      expect([command, mode]).toEqual(["vitest", "run"]);
      // List with the script's arguments so discovery runs without executing nested suites.
      const output = execFileSync(process.execPath, [vitest, "list", ...args, "--filesOnly"], {
        cwd,
        encoding: "utf8",
        timeout: 30_000,
      });
      const files = output.trim().split(/\r?\n/).filter(Boolean);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(file.replaceAll("\\", "/")).toMatch(
          new RegExp(`^\\[[^\\]]+\\] ${directory}/src/.+\\.test\\.tsx?$`),
        );
      }
    },
  );
});
