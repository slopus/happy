#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getReleaseTargets() {
  const rootPackageJson = readJson(path.join(repoRoot, "package.json"));
  const workspacePaths = rootPackageJson.workspaces?.packages;

  if (!Array.isArray(workspacePaths)) {
    throw new Error("No workspace packages found in root package.json");
  }

  const targets = [];
  for (const workspacePath of workspacePaths) {
    if (workspacePath.includes("*")) {
      continue;
    }

    const packageJsonPath = path.join(repoRoot, workspacePath, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }

    const workspacePackageJson = readJson(packageJsonPath);
    if (!workspacePackageJson.scripts || !workspacePackageJson.scripts.release) {
      continue;
    }

    const releaseScript = workspacePackageJson.scripts.release;
    targets.push({
      id: path.basename(workspacePath),
      workspaceName: workspacePackageJson.name,
      workspacePath,
      releaseScript,
      requiresReleaseIt: /\brelease-it\b/.test(releaseScript),
    });
  }

  return targets;
}

function findTarget(targets, input) {
  return targets.find(
    (target) =>
      input === target.id ||
      input === target.workspaceName ||
      input === target.workspacePath
  );
}

function getReleaseItPath(baseDir) {
  const binName = process.platform === "win32" ? "release-it.cmd" : "release-it";
  return path.join(baseDir, "node_modules", ".bin", binName);
}

function ensureReleaseToolingInstalled(target) {
  if (!target.requiresReleaseIt) {
    return;
  }

  const rootReleaseIt = getReleaseItPath(repoRoot);
  const workspaceReleaseIt = getReleaseItPath(path.join(repoRoot, target.workspacePath));

  if (fs.existsSync(rootReleaseIt) || fs.existsSync(workspaceReleaseIt)) {
    return;
  }

  console.error(
    "Missing release tooling: `release-it` is not installed in this checkout."
  );
  console.error("Run `yarn install` from repository root, then run `yarn release` again.");
  process.exit(1);
}

function runRelease(target, releaseArgs = []) {
  ensureReleaseToolingInstalled(target);

  console.log(
    `Running release pipeline for ${target.id} (workspace: ${target.workspaceName})`
  );

  const workspaceBin = path.join(
    repoRoot,
    target.workspacePath,
    "node_modules",
    ".bin"
  );
  const rootBin = path.join(repoRoot, "node_modules", ".bin");
  const existingPath = process.env.PATH || "";
  const releasePath = [workspaceBin, rootBin, existingPath]
    .filter(Boolean)
    .join(path.delimiter);

  const commandArgs = ["workspace", target.workspaceName, "run", "release"];
  if (releaseArgs.length > 0) {
    commandArgs.push(...releaseArgs);
  }

  const result = spawnSync("yarn", commandArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: releasePath,
    },
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
}

async function promptForTarget(targets) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Interactive release selection requires a TTY.");
    console.error("Available targets:");
    for (const target of targets) {
      console.error(`- ${target.id} (workspace: ${target.workspaceName})`);
    }
    console.error("Run `yarn release -- <target> [args...]` in non-interactive mode.");
    process.exit(1);
  }

  let select;
  try {
    ({ select } = await import("@inquirer/prompts"));
  } catch (error) {
    console.error("Missing interactive prompt dependency: `@inquirer/prompts`.");
    console.error("Run `yarn install` from repository root, then run `yarn release` again.");
    process.exit(1);
  }

  const targetId = await select({
    message: "Select workspace to release:",
    pageSize: 10,
    choices: targets.map((target) => ({
      name: `${target.id} (${target.workspaceName})`,
      value: target.id,
      description: target.workspacePath,
    })),
  });

  const target = findTarget(targets, targetId);
  if (!target) {
    console.error("Invalid selection.");
    process.exit(1);
  }

  runRelease(target);
}

async function main() {
  const targets = getReleaseTargets();
  if (targets.length === 0) {
    console.error("No releasable workspace packages found.");
    process.exit(1);
  }

  const input = process.argv[2];
  const releaseArgs = process.argv.slice(3);
  if (input) {
    const target = findTarget(targets, input);
    if (!target) {
      console.error(`Unknown release target: ${input}`);
      console.error("Available targets:");
      for (const candidate of targets) {
        console.error(
          `- ${candidate.id} (workspace: ${candidate.workspaceName}, path: ${candidate.workspacePath})`
        );
      }
      process.exit(1);
    }
    runRelease(target, releaseArgs);
    return;
  }

  await promptForTarget(targets);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
