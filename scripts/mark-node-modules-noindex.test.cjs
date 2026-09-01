const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  collectNodeModulesDirectories,
  markNodeModulesAsNoIndex,
} = require("./mark-node-modules-noindex.cjs");

function createTemporaryRepository(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "paws-spotlight-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

test("marks real node_modules directories on macOS without following symlinks", (t) => {
  const rootDir = createTemporaryRepository(t);
  const rootModules = path.join(rootDir, "node_modules");
  const workspaceModules = path.join(
    rootDir,
    "packages",
    "app",
    "node_modules"
  );
  const externalModules = path.join(
    rootDir,
    "..",
    `${path.basename(rootDir)}-external`
  );

  fs.mkdirSync(rootModules, { recursive: true });
  fs.mkdirSync(workspaceModules, { recursive: true });
  fs.mkdirSync(externalModules, { recursive: true });
  fs.symlinkSync(externalModules, path.join(rootDir, "linked-dependencies"));
  t.after(() => fs.rmSync(externalModules, { recursive: true, force: true }));

  const result = markNodeModulesAsNoIndex({
    rootDir,
    platform: "darwin",
    log: null,
    warn: null,
  });

  assert.equal(result.covered, 2);
  assert.deepEqual(result.failed, []);
  assert.equal(
    fs.existsSync(path.join(rootModules, ".metadata_never_index")),
    true
  );
  assert.equal(
    fs.existsSync(path.join(workspaceModules, ".metadata_never_index")),
    true
  );
  assert.equal(
    fs.existsSync(path.join(externalModules, ".metadata_never_index")),
    false
  );
});

test("creates and marks the root dependency directory before a macOS install", (t) => {
  const rootDir = createTemporaryRepository(t);

  const firstRun = markNodeModulesAsNoIndex({
    rootDir,
    platform: "darwin",
    ensureRoot: true,
    log: null,
    warn: null,
  });
  const secondRun = markNodeModulesAsNoIndex({
    rootDir,
    platform: "darwin",
    ensureRoot: true,
    log: null,
    warn: null,
  });

  assert.equal(firstRun.covered, 1);
  assert.equal(secondRun.covered, 1);
  assert.equal(
    fs.existsSync(path.join(rootDir, "node_modules", ".metadata_never_index")),
    true
  );
});

test("does nothing on non-macOS platforms", (t) => {
  const rootDir = createTemporaryRepository(t);

  const result = markNodeModulesAsNoIndex({
    rootDir,
    platform: "linux",
    ensureRoot: true,
    log: null,
    warn: null,
  });

  assert.deepEqual(result, { covered: 0, failed: [], skipped: true });
  assert.equal(fs.existsSync(path.join(rootDir, "node_modules")), false);
  assert.deepEqual(collectNodeModulesDirectories(rootDir), []);
});
