import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Bot, MemoryDocument, Routine } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  clickAndWaitForRpc,
  completeOnboarding,
  rpc,
  signup,
} from "./helpers";

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps.\n`;

function writeFolder(root: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
}

/** A synthetic OpenClaw workspace, written at run time so the repo holds no agent files. */
const workspaceFiles: Record<string, string> = {
  "SOUL.md": "Calm and direct.\n",
  "AGENTS.md": "Check the calendar before suggesting a time.\n",
  "IDENTITY.md": "- **Name:** Pebble\n- **Vibe:** calm and practical\n- **Emoji:** 🪨\n",
  "MEMORY.md": "The garden project starts in spring.\n",
  "USER.md": "Prefers metric units.\n",
  "TOOLS.md": "Local tool notes.\n",
  "skills/weekly-review/SKILL.md": skill("weekly-review", "Review the week"),
  "notes.txt": "Not Markdown.\n",
};

const homeFiles: Record<string, string> = {
  "openclaw.json": `{
  // JSON5, as OpenClaw writes it
  agents: { defaults: { model: { primary: "deepseek/deepseek-flash" } } },
  gateway: { auth: { token: "placeholder-gateway-token" } },
  channels: { telegram: { botToken: "placeholder-channel-token" } },
  mcp: {
    servers: {
      docs: {
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer placeholder-header-token" },
      },
      files: { command: "npx", args: ["-y", "example-files-server"] },
    },
  },
}
`,
  ".env": [
    "# OpenClaw environment",
    "TERMINAL_TIMEOUT=60",
    "TELEGRAM_BOT_TOKEN=placeholder-telegram",
    "DEEPSEEK_API_KEY=placeholder-deepseek-key",
  ].join("\n"),
  "workspace/skills/cleanup/SKILL.md":
    "---\nname: cleanup\ndescription: Clean the build\n---\n\n```bash\nrm -rf build\n```\n",
  "openclaw.json.bak": '{ "gateway": { "auth": { "token": "placeholder-backup-token" } } }\n',
  "credentials/notes.md": "EXAMPLE_KEY=placeholder\n",
  "workspace/SOUL.md": "Home soul.\n",
  "workspace/MEMORY.md": "Home memory.\n",
  "workspace-other/SOUL.md": "Other agent.\n",
  "skills/inbox-triage/SKILL.md": skill("inbox-triage", "Sort the inbox"),
};

const document = [
  "Here is the document.",
  "",
  "````markdown",
  "# Name",
  "Atlas",
  "",
  "# Instructions",
  "Be concise.",
  "",
  "# Memory",
  "Works remotely.",
  "",
  "## About me",
  "Lives near the coast.",
  "",
  "# Skills",
  "## trip-planner",
  "Plan a trip",
  "1. Ask for dates.",
  "````",
].join("\n");

async function openImport(page: Page) {
  await page.goto("/app?settings=general");
  await page.getByTestId("agent-import-open").click();
  const panel = page.getByTestId("agent-import");
  await expect(panel.getByTestId("agent-import-choose")).toBeVisible();
  return panel;
}

test("imports an OpenClaw folder and another assistant's document as new bots", async ({
  page,
  context,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `agent-import-${stamp}@rakazo.test`, "password12", "Import User");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const importPanel = await openImport(page);
  await importPanel.getByRole("button", { name: "Back", exact: true }).click();
  await expect(importPanel).toHaveCount(0);

  const panel = await openImport(page);
  const choose = panel.getByTestId("agent-import-choose");
  await expect(choose.getByRole("heading")).toHaveText([
    "OpenClaw or Hermes",
    "Grok Bot",
    "Another assistant",
  ]);
  await expect(choose.getByRole("button")).toHaveText([
    "Choose folder",
    "Choose backup",
    "Copy prompt",
    "Continue",
    "Choose file",
    "Copy prompt",
    "Continue",
    "Choose file",
  ]);
  await captureScreenshot(page, testInfo, "agent-import-choose");

  const another = choose.getByTestId("agent-import-another");
  await another.getByRole("textbox", { name: "Paste the reply" }).fill("Just chatting.");
  await another.getByRole("button", { name: "Continue" }).click();
  await expect(panel.getByRole("alert")).toHaveText("No OpenClaw, Hermes or agent document found.");
  await captureScreenshot(page, testInfo, "agent-import-error");

  const home = testInfo.outputPath("openclaw-home");
  writeFolder(home, homeFiles);
  const homeRequest = page.waitForRequest((request) =>
    request.url().includes("/rpc/bots/importPreview"),
  );
  await choose.getByTestId("agent-import-folder").setInputFiles(home);
  const homeBody = (await homeRequest).postData() ?? "";
  const sent = (JSON.parse(homeBody) as { json: { files: { path: string }[] } }).json;
  expect(sent.files.map((file) => file.path).sort()).toEqual([
    "openclaw-home/openclaw.json",
    "openclaw-home/skills/inbox-triage/SKILL.md",
    "openclaw-home/workspace/MEMORY.md",
    "openclaw-home/workspace/SOUL.md",
    "openclaw-home/workspace/skills/cleanup/SKILL.md",
  ]);
  // Without the opt-in, no credential value leaves the browser.
  expect(homeBody).not.toContain("placeholder-");
  const homePreview = panel.getByTestId("agent-import-preview");
  for (const [section, names] of [
    ["agent-import-instructions", ["SOUL.md"]],
    ["agent-import-memory", ["MEMORY.md"]],
    ["agent-import-skills", ["cleanup", "inbox-triage"]],
  ] as const) {
    const boxes = homePreview.getByTestId(section).getByRole("checkbox");
    await expect(boxes).toHaveCount(names.length);
    for (const [index, name] of names.entries()) {
      await expect(boxes.nth(index)).toHaveAccessibleName(name);
    }
  }
  const skills = homePreview.getByTestId("agent-import-skills");
  await expect(skills.getByRole("checkbox", { name: "cleanup" })).not.toBeChecked();
  await expect(skills.getByRole("checkbox", { name: "inbox-triage" })).not.toBeChecked();
  await expect(skills.getByText("Contains code to run", { exact: true })).toBeVisible();
  // A ready item needs no label: the checkbox says enough.
  await expect(homePreview.getByText("Ready", { exact: true })).toHaveCount(0);
  const mcp = homePreview.getByTestId("agent-import-mcp");
  await expect(mcp.getByRole("checkbox", { name: "docs" })).not.toBeChecked();
  await expect(mcp.getByText("Credentials: Authorization", { exact: true })).toBeVisible();
  await expect(mcp.getByRole("checkbox", { name: "files" })).toBeDisabled();
  await expect(mcp.getByText("Not supported in Rakazo", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "agent-import-compatibility");
  // Choices made before the opt-in survive it, in both directions.
  const nameBox = homePreview.getByRole("textbox", { name: "Name" });
  await nameBox.fill("Home bot");
  await skills.getByRole("checkbox", { name: "inbox-triage" }).click();
  await expect(skills.getByRole("checkbox", { name: "inbox-triage" })).toBeChecked();
  await homePreview
    .getByTestId("agent-import-instructions")
    .getByRole("button", { name: "SOUL.md", exact: true })
    .click();
  await expect(
    homePreview.getByTestId("agent-import-instructions").getByTestId("agent-import-content"),
  ).toHaveText("Home soul.");
  const model = homePreview.getByTestId("agent-import-model");
  const modelBox = model.getByRole("checkbox", {
    name: "deepseek/deepseek-flash",
  });
  await expect(modelBox).toBeDisabled();
  await expect(model.getByText("API key for DeepSeek", { exact: true })).toBeVisible();
  const keys = homePreview.getByTestId("agent-import-keys");
  const optIn = keys.getByRole("checkbox", { name: "Include API keys" });
  await expect(optIn).not.toBeChecked();
  const optedRequest = page.waitForRequest((request) =>
    request.url().includes("/rpc/bots/importPreview"),
  );
  await optIn.click();
  const optedBody = (await optedRequest).postData() ?? "";
  const opted = (
    JSON.parse(optedBody) as {
      json: { includeSecrets: boolean; files: { path: string; content: string }[] };
    }
  ).json;
  expect(opted.includeSecrets).toBe(true);
  // Only the model-provider key leaves the browser; no other secret or setting does.
  expect(opted.files.find((file) => file.path === "openclaw-home/.env")?.content).toBe(
    "DEEPSEEK_API_KEY=placeholder-deepseek-key\n",
  );
  for (const secret of [
    "placeholder-gateway-token",
    "placeholder-channel-token",
    "placeholder-telegram",
    "placeholder-header-token",
    "TERMINAL_TIMEOUT",
  ]) {
    expect(optedBody).not.toContain(secret);
  }
  await expect(optIn).toBeChecked();
  await expect(keys.getByRole("heading", { name: "API keys" })).toBeVisible();
  await expect(keys.getByRole("checkbox", { name: "DeepSeek" })).toBeChecked();
  await expect(modelBox).toBeEnabled();
  await expect(modelBox).toBeChecked();
  await expect(homePreview).not.toContainText("placeholder-");
  await captureScreenshot(page, testInfo, "agent-import-preview-settings");
  await expect(nameBox).toHaveValue("Home bot");
  await expect(skills.getByRole("checkbox", { name: "inbox-triage" })).toBeChecked();
  await optIn.click();
  await expect(optIn).not.toBeChecked();
  await expect(keys.getByRole("heading", { name: "API keys" })).toHaveCount(0);
  await expect(nameBox).toHaveValue("Home bot");
  await expect(skills.getByRole("checkbox", { name: "inbox-triage" })).toBeChecked();
  await expect(skills.getByRole("checkbox", { name: "cleanup" })).not.toBeChecked();
  await panel.getByRole("button", { name: "Back", exact: true }).click();

  const workspace = testInfo.outputPath("workspace");
  writeFolder(workspace, workspaceFiles);
  await choose.getByTestId("agent-import-folder").setInputFiles(workspace);
  const preview = panel.getByTestId("agent-import-preview");
  await expect(preview).toBeVisible();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(preview.getByRole("heading")).toHaveText([
    "Instructions",
    "Memory",
    "Skills",
    "Not imported",
  ]);
  for (const [section, names, ticked] of [
    ["agent-import-instructions", ["SOUL.md", "AGENTS.md"], true],
    ["agent-import-memory", ["MEMORY.md", "USER.md"], true],
    ["agent-import-skills", ["weekly-review"], false],
  ] as const) {
    const boxes = preview.getByTestId(section).getByRole("checkbox");
    await expect(boxes).toHaveCount(names.length);
    for (const [index, name] of names.entries()) {
      await expect(boxes.nth(index)).toHaveAccessibleName(name);
      if (ticked) await expect(boxes.nth(index)).toBeChecked();
      else await expect(boxes.nth(index)).not.toBeChecked();
    }
  }
  await preview.getByRole("button", { name: "Not imported", exact: true }).click();
  await expect(preview.getByTestId("agent-import-skipped").getByRole("listitem")).toHaveText([
    /IDENTITY\.md: Emoji\s*Not used by Rakazo/,
    /TOOLS\.md\s*Not used by Rakazo/,
  ]);
  // IDENTITY.md names and describes the bot; it is not part of its instructions.
  await expect(preview.getByRole("textbox", { name: "Name" })).toHaveValue("Pebble");
  await expect(preview.getByRole("textbox", { name: "Description" })).toHaveValue(
    "calm and practical",
  );
  await captureScreenshot(page, testInfo, "agent-import-preview");

  const memorySection = preview.getByTestId("agent-import-memory");
  const memoryTitle = memorySection.getByRole("button", { name: "MEMORY.md", exact: true });
  await expect(memoryTitle).toHaveAttribute("aria-expanded", "false");
  await memoryTitle.click();
  await expect(memoryTitle).toHaveAttribute("aria-expanded", "true");
  await expect(memorySection.getByTestId("agent-import-content")).toHaveText(
    "The garden project starts in spring.",
  );
  await captureScreenshot(page, testInfo, "agent-import-preview-expanded");

  await preview.getByRole("checkbox", { name: "USER.md", exact: true }).click();
  await expect(preview.getByRole("checkbox", { name: "USER.md", exact: true })).not.toBeChecked();
  await clickAndWaitForRpc(
    page,
    preview.getByRole("button", { name: "Create", exact: true }),
    "bots/importCreate",
  );
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(page.getByPlaceholder("Message Pebble")).toBeVisible();
  const pebbleId = activeBotId(page);
  const pebble = await rpc<Bot>(page, "bots/get", { botId: pebbleId });
  expect(pebble.instructions).toBe(
    "# Persona\n\nCalm and direct.\n\n# Working instructions\n\nCheck the calendar before suggesting a time.",
  );
  expect(pebble.description).toBe("calm and practical");
  const pebbleSkills = await rpc<{ name: string }[]>(page, "agentSkills/list", {});
  expect(pebbleSkills.some((item) => item.name === "weekly-review")).toBe(false);
  const pebbleMemory = await rpc<MemoryDocument[]>(page, "memory/list", { botId: pebbleId });
  expect(pebbleMemory.map((doc) => [doc.path, doc.content])).toEqual([
    ["MEMORY.md", "The garden project starts in spring.\n"],
  ]);
  const spaceMemory = await rpc<MemoryDocument[]>(page, "memory/list", { scope: "user" });
  expect(spaceMemory.some((doc) => doc.content.includes("Prefers metric units."))).toBe(false);

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const second = await openImport(page);
  const secondAnother = second.getByTestId("agent-import-another");
  await secondAnother.getByRole("button", { name: "Copy prompt" }).click();
  await expect(secondAnother.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("\n# Skills\n");
  await secondAnother.getByRole("textbox", { name: "Paste the reply" }).fill(document);
  await secondAnother.getByRole("button", { name: "Continue" }).click();
  const documentPreview = second.getByTestId("agent-import-preview");
  await expect(
    documentPreview.getByTestId("agent-import-memory").getByRole("checkbox"),
  ).toHaveCount(2);
  await expect(documentPreview.getByRole("checkbox", { name: "About me" })).toBeChecked();
  await expect(documentPreview.getByRole("checkbox", { name: "trip-planner" })).not.toBeChecked();
  await documentPreview.getByRole("checkbox", { name: "trip-planner" }).click();
  await expect(documentPreview.getByRole("textbox", { name: "Name" })).toHaveValue("Atlas");
  await clickAndWaitForRpc(
    page,
    documentPreview.getByRole("button", { name: "Create", exact: true }),
    "bots/importCreate",
  );
  await page.waitForURL((url) => !url.pathname.endsWith(pebbleId));
  await expect(page.getByPlaceholder("Message Atlas")).toBeVisible();
  const atlasId = activeBotId(page);
  expect((await rpc<Bot>(page, "bots/get", { botId: atlasId })).instructions).toBe("Be concise.");
  const atlasMemory = await rpc<MemoryDocument[]>(page, "memory/list", { botId: atlasId });
  expect(atlasMemory.map((doc) => doc.path).sort()).toEqual(["MEMORY.md", "about-me.md"]);
  const library = await rpc<{ name: string }[]>(page, "agentSkills/list", {});
  expect(library.map((item) => item.name)).toEqual(expect.arrayContaining(["trip-planner"]));
});

/** What a Grok Bot writes back for the export prompt: fake data, in a chat reply. */
const grokBot = {
  name: "Bramble",
  title: "Account manager",
  instructions: "Keep replies short.",
  memories: ["Weekly report goes out on Mondays."],
  user_facts: ["Time zone: America/New_York"],
  skills: [
    {
      name: "Weekly Account Health",
      description: "Use for the Monday account review.",
      instructions: "1. List accounts.\n2. Flag the ones at risk.",
    },
  ],
  routines: [
    {
      name: "Monday review",
      instruction: "Run the weekly account review.",
      trigger: "schedule",
      schedule_cron: "0 8 * * 1",
      timezone: "America/New_York",
      skills: ["Weekly Account Health"],
    },
    { name: "Support pings", instruction: "Answer #support.", trigger: "slack" },
  ],
  apps: [{ name: "Gmail" }],
};

function grokReply(...bots: object[]) {
  const body = JSON.stringify({ format: "grok-bot-export", version: 1, bots }, null, 2);
  return `Here is my setup.\n\n\`\`\`json\n${body}\n\`\`\``;
}

test("imports a Grok Bot export as a new bot", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `grok-import-${stamp}@rakazo.test`, "password12", "Grok User");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const panel = await openImport(page);
  const grok = panel.getByTestId("agent-import-grok");
  await grok
    .getByRole("textbox", { name: "Paste the reply" })
    .fill(grokReply(grokBot, { name: "Wren", instructions: "Plan trips." }));
  await grok.getByRole("button", { name: "Continue" }).click();
  await expect(grok.getByText("Which Bot?")).toBeVisible();
  await captureScreenshot(page, testInfo, "agent-import-grok-choose-bot");
  await clickAndWaitForRpc(
    page,
    grok.getByRole("button", { name: "Bramble", exact: true }),
    "bots/importPreview",
  );

  const preview = panel.getByTestId("agent-import-preview");
  await expect(preview.getByRole("textbox", { name: "Name" })).toHaveValue("Bramble");
  await expect(preview.getByTestId("agent-import-memory").getByRole("checkbox")).toHaveCount(3);
  await expect(preview.getByRole("checkbox", { name: "grok-bot-routines.md" })).toBeChecked();
  const skill = preview.getByRole("checkbox", { name: "weekly-account-health" });
  const routine = preview.getByRole("checkbox", { name: "Monday review" });
  await expect(skill).not.toBeChecked();
  await expect(routine).not.toBeChecked();
  await preview.getByRole("button", { name: "Not imported" }).click();
  await expect(preview.getByTestId("agent-import-skipped")).toContainText(
    "apps: GmailConnect it again",
  );
  await captureScreenshot(page, testInfo, "agent-import-grok-preview");

  await skill.click();
  await routine.click();
  await clickAndWaitForRpc(
    page,
    preview.getByRole("button", { name: "Create", exact: true }),
    "bots/importCreate",
  );
  await expect(page.getByPlaceholder("Message Bramble")).toBeVisible();
  const botId = activeBotId(page);
  expect((await rpc<Bot>(page, "bots/get", { botId })).instructions).toBe("Keep replies short.");
  const memory = await rpc<MemoryDocument[]>(page, "memory/list", { botId });
  expect(memory.map((doc) => doc.path).sort()).toEqual([
    "MEMORY.md",
    "USER.md",
    "grok-bot-routines.md",
  ]);
  const skills = await rpc<{ name: string }[]>(page, "agentSkills/list", {});
  expect(skills.map((item) => item.name)).toContain("weekly-account-health");
  const routines = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(routines).toMatchObject([
    { name: "Monday review", active: false, crons: ["0 8 * * 1"], timezone: "America/New_York" },
  ]);
  expect(routines[0]!.prompt).toContain("@weekly-account-health");
});
