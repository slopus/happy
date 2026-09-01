const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_DEPTH = 4;
const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".cache",
  ".expo",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "test-results",
]);

function collectNodeModulesDirectories(rootDir, maxDepth = DEFAULT_MAX_DEPTH) {
  const directories = [];

  function visit(currentDirectory, depth) {
    let entries;
    try {
      entries = fs.readdirSync(currentDirectory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.name === "node_modules") {
        directories.push(entryPath);
        continue;
      }

      if (depth >= maxDepth || SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
        continue;
      }

      visit(entryPath, depth + 1);
    }
  }

  visit(rootDir, 0);
  return directories;
}

function markNodeModulesAsNoIndex({
  rootDir = path.resolve(__dirname, ".."),
  platform = process.platform,
  ensureRoot = false,
  maxDepth = DEFAULT_MAX_DEPTH,
  log = console.log,
  warn = console.warn,
} = {}) {
  if (platform !== "darwin") {
    return { covered: 0, failed: [], skipped: true };
  }

  const rootNodeModules = path.join(rootDir, "node_modules");
  if (ensureRoot) {
    fs.mkdirSync(rootNodeModules, { recursive: true });
  }

  const failed = [];
  let covered = 0;

  for (const directory of collectNodeModulesDirectories(rootDir, maxDepth)) {
    const markerPath = path.join(directory, ".metadata_never_index");
    try {
      fs.closeSync(fs.openSync(markerPath, "a", 0o644));
      covered += 1;
    } catch (error) {
      failed.push({ directory, error });
      warn?.(`[spotlight] Unable to mark ${directory}: ${error.message}`);
    }
  }

  if (covered > 0) {
    log?.(
      `[spotlight] Excluded ${covered} node_modules director${
        covered === 1 ? "y" : "ies"
      } from indexing`
    );
  }

  return { covered, failed, skipped: false };
}

if (require.main === module) {
  markNodeModulesAsNoIndex({
    ensureRoot: process.argv.includes("--ensure-root"),
  });
}

module.exports = {
  collectNodeModulesDirectories,
  markNodeModulesAsNoIndex,
};
