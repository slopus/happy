#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");
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

    targets.push({
      id: path.basename(workspacePath),
      workspaceName: workspacePackageJson.name,
      workspacePath,
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

function runRelease(target) {
  ensureReleaseToolingInstalled(target);

  console.log(
    `Running release pipeline for ${target.id} (workspace: ${target.workspaceName})`
  );

  const result = spawnSync(
    "yarn",
    ["workspace", target.workspaceName, "run", "release"],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    }
  );

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
}

function promptForTarget(targets) {
  console.log("Select library to release:");
  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    console.log(`${i + 1}. ${target.id} (${target.workspaceName})`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question("Enter number: ", (answer) => {
    rl.close();
    const index = Number.parseInt(answer, 10);

    if (!Number.isInteger(index) || index < 1 || index > targets.length) {
      console.error("Invalid selection.");
      process.exit(1);
    }

    runRelease(targets[index - 1]);
  });
}

function main() {
  const targets = getReleaseTargets();
  if (targets.length === 0) {
    console.error("No releasable workspace packages found.");
    process.exit(1);
  }

  const input = process.argv[2];
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
    runRelease(target);
    return;
  }

  promptForTarget(targets);
}

main();
