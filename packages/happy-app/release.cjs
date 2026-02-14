#!/usr/bin/env node

const { spawnSync } = require("child_process");

const workspaceRoot = __dirname;

const actions = [
  {
    id: "all",
    label: "All",
    description: "Developer build and App Store build",
    scripts: [
      "release:build:developer",
      "release:build:appstore",
    ],
  },
  {
    id: "all-interactive",
    label: "All interactive",
    description: "All build steps with interactive prompts when needed",
    scripts: [
      "release:build:developer:interactive",
      "release:build:appstore:interactive",
    ],
  },
  {
    id: "developer-build",
    label: "Developer build",
    description: "Run development/preview builds plus TestFlight store submissions",
    scripts: ["release:build:developer"],
  },
  {
    id: "appstore-build",
    label: "App Store build",
    description: "Run production store builds and auto-submit",
    scripts: ["release:build:appstore"],
  },
  {
    id: "ota-preview",
    label: "OTA (preview)",
    description: "Publish an update to the preview channel",
    scripts: ["release:ota:preview"],
  },
  {
    id: "ota-release",
    label: "OTA (release)",
    description: "Publish an update to the production channel",
    scripts: ["release:ota:release"],
  },
];

const actionAliases = {
  all: "all",
  interactive: "all-interactive",
  "all-interactive": "all-interactive",
  "all interactive": "all-interactive",
  developer: "developer-build",
  dev: "developer-build",
  "developer-build": "developer-build",
  appstore: "appstore-build",
  store: "appstore-build",
  "appstore-build": "appstore-build",
  "ota-preview": "ota-preview",
  "ota:preview": "ota-preview",
  preview: "ota-preview",
  "ota-release": "ota-release",
  "ota:release": "ota-release",
  production: "ota-release",
};

function findAction(input) {
  const normalized = String(input || "").trim().toLowerCase();
  const actionId = actionAliases[normalized] || normalized;
  return actions.find((action) => action.id === actionId);
}

function printAvailableOptions() {
  console.error("Available happy-app release options:");
  for (const action of actions) {
    console.error(`- ${action.id}: ${action.description}`);
  }
}

function runScript(scriptName) {
  console.log(`> yarn run ${scriptName}`);
  const result = spawnSync("yarn", ["run", scriptName], {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function promptForAction() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Interactive happy-app release selection requires a TTY.");
    printAvailableOptions();
    console.error("Run `yarn release -- <option>` in non-interactive mode.");
    process.exit(1);
  }

  let select;
  try {
    ({ select } = await import("@inquirer/prompts"));
  } catch (error) {
    console.error("Missing interactive prompt dependency: `@inquirer/prompts`.");
    console.error(
      "Run `yarn install` from repository root, then run `yarn workspace happy-app release` again."
    );
    process.exit(1);
  }

  const actionId = await select({
    message: "What should be released for happy-app?",
    pageSize: 10,
    choices: actions.map((action) => ({
      name: action.label,
      value: action.id,
      description: action.description,
    })),
  });

  return findAction(actionId);
}

async function main() {
  const input = process.argv[2];
  if (input === "--help" || input === "-h") {
    console.log("Usage: yarn release -- <option>");
    printAvailableOptions();
    return;
  }

  let action = input ? findAction(input) : null;
  if (input && !action) {
    console.error(`Unknown happy-app release option: ${input}`);
    printAvailableOptions();
    process.exit(1);
  }

  if (!action) {
    action = await promptForAction();
  }

  console.log(`Running happy-app release option: ${action.label}`);
  for (const scriptName of action.scripts) {
    runScript(scriptName);
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
