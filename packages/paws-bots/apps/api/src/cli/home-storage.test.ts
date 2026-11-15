import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "vitest";

// Run the actual CLI in a separate process with offline replacements for its external services.
function run(scenario: string, args = ["migrate"]) {
  const dir = mkdtempSync(path.join(tmpdir(), "home-storage-test-"));
  try {
    const source = readFileSync(new URL("./home-storage.ts", import.meta.url), "utf8")
      .replace('"@rakazo/adapters"', '"./stubs.mjs"')
      .replace('"@rakazo/core/node/load-root-env"', '"./stubs.mjs"')
      .replace('"@rakazo/db"', '"./stubs.mjs"');
    writeFileSync(path.join(dir, "cli.mts"), source);
    writeFileSync(
      path.join(dir, "stubs.mjs"),
      `
export const loadRootEnv = () => {};
export const unwrapEnvFromKeyManager = async () => {};
export const contentKeyProviderFromEnv = () => undefined;
export const createDb = () => ({
  prisma: { $disconnect: async () => { console.log("cleanup: prisma"); if (process.env.SCENARIO === "cleanup-signal") process.emit("SIGTERM"); if (process.env.SCENARIO === "cleanup-error") throw Error("disconnect"); } },
  pool: { end: async () => { console.log("cleanup: pool"); } },
});
export class ObjectAgentHomeStore {
  async localHomes() {
    if (process.env.SCENARIO === "list-error") throw Error("list failed");
    return ["first", "second"];
  }
  async migrateLocal(key) {
    console.log("migrate: " + key);
    if (key === "first" && ["SIGINT", "SIGTERM"].includes(process.env.SCENARIO)) process.emit(process.env.SCENARIO);
    if (key === "first" && process.env.SCENARIO === "migrate-error") throw Error("upload failed");
    return "uploaded";
  }
}
export const createAgentHomeStore = () => new ObjectAgentHomeStore();
`,
    );
    return spawnSync(process.execPath, [path.join(dir, "cli.mts"), ...args], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, DATABASE_URL: "offline", SCENARIO: scenario },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertCleanup(stdout: string) {
  assert.match(stdout, /cleanup: prisma/);
  assert.match(stdout, /cleanup: pool/);
}

it("completes all homes and exits successfully", () => {
  const result = run("normal");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /migrate: first/);
  assert.match(result.stdout, /migrate: second/);
  assert.doesNotMatch(result.stdout, /stopped early/);
  assertCleanup(result.stdout);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  it(`exits nonzero after ${signal}, leaving remaining homes for a later run`, () => {
    const result = run(signal);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /migrate: first/);
    assert.doesNotMatch(result.stdout, /migrate: second/);
    assert.match(result.stdout, /stopped early/);
    assertCleanup(result.stdout);
  });
}

it("reports a migration failure and continues with the next home", () => {
  const result = run("migrate-error");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /failed \(upload failed\)/);
  assert.match(result.stdout, /migrate: second/);
  assertCleanup(result.stdout);
});

it("reports a listing failure and cleans up", () => {
  const result = run("list-error");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /list failed/);
  assertCleanup(result.stdout);
});

it("attempts both cleanup operations even if disconnect fails", () => {
  const result = run("cleanup-error");
  assert.equal(result.status, 0, result.stderr);
  assertCleanup(result.stdout);
});

it("exits nonzero if interrupted during cleanup", () => {
  const result = run("cleanup-signal");
  assert.equal(result.status, 1, result.stderr);
  assertCleanup(result.stdout);
});

it("rejects invalid arguments", () => {
  const result = run("normal", ["invalid"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: home-storage/);
});
