import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { composeBaseArgs } from "./compose-stack.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

describe("compose stack reachability", () => {
  it("applies the root env file to every compose invocation, like scripts/backup.sh", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "rakazo-compose-stack-"));
    try {
      const composeFile = path.join(root, "infra/compose/docker-compose.yml");
      writeFileSync(path.join(root, ".env"), "POSTGRES_APP_PASSWORD=fake-value\n");
      expect(composeBaseArgs(root)).toEqual([
        "compose",
        "--env-file",
        path.join(root, ".env"),
        "-f",
        composeFile,
      ]);
      rmSync(path.join(root, ".env"));
      expect(composeBaseArgs(root)).toEqual(["compose", "-f", composeFile]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A silent skip reads as a verified backup, so the opted-in suite must fail when the stack
  // is unreachable. A fake docker on PATH reports the stack down and records the invocation.
  it("fails the opted-in backup suite instead of skipping when the stack is unreachable", {
    timeout: 180_000,
  }, () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), "rakazo-fake-docker-"));
    try {
      const log = path.join(bin, "docker.log");
      writeFileSync(
        path.join(bin, "docker"),
        `#!/usr/bin/env bash
echo "$*" >> "$FAKE_DOCKER_LOG"
exit 1
`,
      );
      chmodSync(path.join(bin, "docker"), 0o755);
      // Nested vitest must not inherit the parent's VITEST_* / pool env — under sharding that
      // leaves the child unable to resolve vitest/config and fails before the suite can run.
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(childEnv)) {
        if (key.startsWith("VITEST_") || key === "NODE_V8_COVERAGE") {
          delete childEnv[key];
        }
      }
      const result = spawnSync(
        "pnpm",
        ["exec", "vitest", "run", "packages/testkit/src/compose.backup.test.ts"],
        {
          cwd: repoRoot,
          env: {
            ...childEnv,
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
            VERIFY_COMPOSE_BACKUP: "1",
            FAKE_DOCKER_LOG: log,
          },
          encoding: "utf8",
          timeout: 170_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("not reachable");
      // The reachability probe went through the same compose invocation as the suite.
      expect(readFileSync(log, "utf8")).toContain("pg_isready");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
