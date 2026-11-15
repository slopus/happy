import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { MemoryDocument } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  openBotPanelTab,
  openUserSettings,
  rpc,
  signup,
} from "./helpers";

test("memory and skills are readable and editable in the app", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const userName = `Knowledge ${stamp}`;
  await signup(page, `knowledge-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  // A second shared document that the user can delete later in this test. Saving shared
  // memory from chat writes directly, without an approval card.
  const retiredPath = "projects/retired.md";
  const retiredContent = `Retired project ${stamp}`;
  const setupComposer = page.getByRole("combobox", { name: "Message Chief" });
  await setupComposer.fill(`save shared memory ${retiredPath} with: ${retiredContent}`);
  await setupComposer.press("Enter");
  await expect
    .poll(
      async () =>
        (await rpc<MemoryDocument[]>(page, "memory/list", { scope: "user" })).find(
          (doc) => doc.path === retiredPath,
        )?.content,
      { timeout: 30_000 },
    )
    .toBe(retiredContent);
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);

  // Space-wide documents live in Settings → Memory. Open that before bot
  // settings so the Knowledge Memory tab cannot steal this click.
  await openUserSettings(page, "memory");
  await expect(page.getByLabel("Close memory settings")).toBeVisible();
  const spaceDocs = page.getByTestId("space-memory-documents");
  const memoryRow = spaceDocs.getByRole("button", { name: /MEMORY\.md/ });
  await expect(memoryRow).toBeVisible();
  await memoryRow.click();
  const docEditor = spaceDocs.locator("textarea");
  const marker = `Edited in e2e ${stamp}`;
  await docEditor.fill(`# Memory\n\n${marker}\n`);
  await captureScreenshot(page, testInfo, "83-space-memory-editor");
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route(
    "**/rpc/memory/update",
    async (route) => {
      await saveGate;
      await route.continue();
    },
    { times: 1 },
  );
  await spaceDocs.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await expect(docEditor).toBeDisabled();
    await expect(memoryRow).toBeDisabled();
    await expect(spaceDocs.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  } finally {
    releaseSave();
  }

  await memoryRow.click();
  await expect(docEditor).toHaveValue(new RegExp(marker));
  await captureScreenshot(page, testInfo, "84-space-memory-saved");
  const sharedDocuments = await rpc<MemoryDocument[]>(page, "memory/list", { scope: "user" });
  expect(sharedDocuments).toContainEqual(
    expect.objectContaining({ content: `# Memory\n\n${marker}\n`, revision: 2 }),
  );
  // Export must fetch fresh content and exclude the bot's private document.
  const sharedDocument = sharedDocuments.find((doc) => doc.path === "MEMORY.md")!;
  const latestMarker = `Latest shared memory ${stamp}`;
  await rpc(page, "memory/update", { documentId: sharedDocument.id, content: latestMarker });
  // A concurrent writer must not be overwritten by this open editor.
  await docEditor.fill("Unsaved draft");
  await spaceDocs.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    spaceDocs.getByText("Document changed. Reopen to edit the latest version.", { exact: true }),
  ).toBeVisible();
  await expect(docEditor).toHaveValue("Unsaved draft");
  await expect(spaceDocs.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  expect(await rpc<MemoryDocument[]>(page, "memory/list", { scope: "user" })).toContainEqual(
    expect.objectContaining({ id: sharedDocument.id, content: latestMarker, revision: 3 }),
  );
  await captureScreenshot(page, testInfo, "84-space-memory-conflict");
  const downloadPromise = page.waitForEvent("download");
  // Document order is not fixed, so download from the MEMORY.md row itself.
  await spaceDocs
    .locator("div.border-b")
    .filter({ has: page.getByRole("button", { name: "MEMORY.md", exact: true }) })
    .getByRole("button", { name: "Download", exact: true })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("MEMORY.md");
  const exported = await readFile((await download.path())!, "utf8");
  expect(exported).toBe(latestMarker);
  expect(exported).not.toContain(retiredContent);
  expect(exported).not.toContain(marker);
  expect(exported).not.toContain("# Chief");
  // Exporting must not hide why Save stays disabled.
  const conflictNotice = spaceDocs.getByText(
    "Document changed. Reopen to edit the latest version.",
    { exact: true },
  );
  await expect(conflictNotice).toBeVisible();
  await expect(spaceDocs.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await spaceDocs.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(conflictNotice).toHaveCount(0);
  await memoryRow.click();
  await expect(docEditor).toHaveValue(latestMarker);

  // Any shared document but MEMORY.md can be deleted after a confirmation.
  // MEMORY.md editor is open again after the reopen above; do not toggle it closed.
  await expect(spaceDocs.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await spaceDocs.getByRole("button", { name: "Cancel", exact: true }).click();
  const retiredRow = spaceDocs.getByRole("button", { name: new RegExp(retiredPath) });
  await retiredRow.click();
  await expect(spaceDocs.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "85-space-memory-delete");
  await spaceDocs.getByRole("button", { name: "Delete", exact: true }).click();
  await captureScreenshot(page, testInfo, "85-space-memory-confirm-delete");
  await spaceDocs.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(retiredRow).toHaveCount(0);
  expect(
    (await rpc<MemoryDocument[]>(page, "memory/list", { scope: "user" })).map((doc) => doc.path),
  ).not.toContain(retiredPath);
  await page.getByLabel("Close memory settings").click();
  await expect(page.getByLabel("Close memory settings")).toHaveCount(0);

  const seededDocs = await rpc<MemoryDocument[]>(page, "memory/list", {
    botId: activeBotId(page),
    scope: "bot",
  });
  await rpc(page, "memory/update", {
    documentId: seededDocs[0]!.id,
    content: "# Chief\n\nA remembered preference.\n",
  });
  await openBotPanelTab(page, "Advanced");
  const settings = page.getByTestId("bot-settings");
  await expect(settings.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  const botMemory = settings.getByTestId("bot-knowledge-memory");
  const botMemoryRow = botMemory.getByRole("button", { name: /MEMORY\.md/ });
  await expect(botMemoryRow).toBeVisible();
  await botMemoryRow.click();
  const botDocEditor = botMemory.locator("textarea");
  await expect(botDocEditor).toHaveValue(/# Chief/);
  const botMarker = `Bot memory e2e ${stamp}`;
  await botDocEditor.fill(`# Chief\n\n${botMarker}\n`);
  await botMemory.getByRole("button", { name: "Save", exact: true }).scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "80-knowledge-bot-memory");
  const botMemorySaved = page.waitForResponse(
    (response) => response.url().includes("/rpc/memory/update") && response.ok(),
  );
  await botMemory.getByRole("button", { name: "Save", exact: true }).click();
  await botMemorySaved;
  expect(
    await rpc<MemoryDocument[]>(page, "memory/list", {
      botId: activeBotId(page),
      scope: "bot",
    }),
  ).toContainEqual(expect.objectContaining({ content: `# Chief\n\n${botMarker}\n`, revision: 3 }));
  await botMemoryRow.click();
  await expect(botDocEditor).toHaveValue(new RegExp(botMarker));
  await botMemory.getByRole("button", { name: "Cancel", exact: true }).click();

  // Skills belong to the person in this space, so they open from the account menu, not bot settings.
  await expect(settings.getByTestId("bot-knowledge-skills")).toHaveCount(0);
  const openSkills = async () => {
    await page.getByTestId("user-menu-trigger").click();
    await page.getByRole("button", { name: "Skills", exact: true }).click();
  };
  const skillsDialog = page.getByRole("dialog", { name: "Skills", exact: true });
  const closeSkills = () =>
    skillsDialog.getByRole("button", { name: "Close skills", exact: true }).click();
  await openSkills();
  const knowledge = skillsDialog.getByTestId("your-skills");
  const builtinSkill = knowledge.getByRole("button", { name: /Interrogate/ });
  await expect(builtinSkill).toBeVisible();
  await expect(builtinSkill.getByText("Built-in", { exact: true })).toBeVisible();
  await knowledge.getByRole("button", { name: "New skill", exact: true }).click();
  const editor = knowledge.locator("textarea");
  await editor.fill(
    [
      "---",
      "name: greet-politely",
      "description: Say hello before anything else.",
      "---",
      "",
      "Always open with a greeting.",
    ].join("\n"),
  );
  await captureScreenshot(page, testInfo, "81-knowledge-skill-editor");
  await knowledge.getByRole("button", { name: "Save", exact: true }).click();
  const skillRow = knowledge.getByRole("button", { name: /greet-politely/ });
  await expect(skillRow).toBeVisible();
  await expect(knowledge.getByText("Say hello before anything else.")).toBeVisible();
  await expect(builtinSkill.getByText("Built-in", { exact: true })).toBeVisible();
  const listedShot = testInfo.outputPath("82-knowledge-skill-listed.png");
  await knowledge.screenshot({ animations: "disabled", caret: "hide", path: listedShot });
  await testInfo.attach("82-knowledge-skill-listed", {
    contentType: "image/png",
    path: listedShot,
  });
  await closeSkills();
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill("/");
  await expect(
    page.getByRole("button", { name: "Skill greet-politely", exact: true }),
  ).toBeVisible();
  await composer.fill("");
  await openSkills();

  // A provider-owned skill uses the same viewer without mutation controls.
  await page.route(
    "**/rpc/agentSkills/get",
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: { ...body, json: { ...body.json, readOnly: true, source: "plugin" } },
      });
    },
    { times: 1 },
  );
  await skillRow.click();
  await expect(editor).toHaveAttribute("readonly", "");
  await expect(knowledge.getByText("Plugin", { exact: true })).toBeVisible();
  await expect(knowledge.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await expect(knowledge.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await knowledge.getByRole("button", { name: "Close", exact: true }).click();
  await skillRow.click();
  await expect(editor).toHaveValue(/Always open with a greeting/);
  await editor.fill(
    [
      "---",
      "name: greet-politely",
      "description: Say hello before anything else.",
      "---",
      "",
      "Open with a warm greeting.",
    ].join("\n"),
  );
  let releaseSkillRefresh!: () => void;
  const skillRefreshGate = new Promise<void>((resolve) => {
    releaseSkillRefresh = resolve;
  });
  await page.route(
    "**/rpc/agentSkills/list",
    async (route) => {
      await skillRefreshGate;
      await route.continue();
    },
    { times: 1 },
  );
  await knowledge.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await expect(editor).toBeHidden();
    await expect(skillRow).toBeDisabled();
    await captureScreenshot(page, testInfo, "85-skill-refresh-pending");
  } finally {
    releaseSkillRefresh();
  }
  await skillRow.click();
  await expect(editor).toHaveValue(/warm greeting/);
  await knowledge.getByRole("button", { name: "Delete", exact: true }).click();
  await knowledge.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(skillRow).toBeHidden();
  await closeSkills();
  await composer.fill("/");
  await expect(page.getByRole("button", { name: "Skill greet-politely", exact: true })).toHaveCount(
    0,
  );
  expect(await rpc<Array<{ name: string }>>(page, "agentSkills/list", {})).not.toContainEqual(
    expect.objectContaining({ name: "greet-politely" }),
  );
});

test("a new bot hides its untouched memory index", async ({ page }, testInfo) => {
  await signup(page, `empty-memory-${Date.now()}@example.test`, "password12", "Sample");
  await completeOnboarding(page);
  const botId = await createNamedBot(page, "Researcher");
  const docs = await rpc<MemoryDocument[]>(page, "memory/list", { botId, scope: "bot" });
  expect(docs).toEqual([
    expect.objectContaining({ path: "MEMORY.md", content: "# Researcher\n\n" }),
  ]);
  const memoryLoaded = page.waitForResponse(
    (response) => response.url().includes("/rpc/memory/list") && response.ok(),
  );
  await openBotPanelTab(page, "Advanced");
  await memoryLoaded;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const settings = page.getByTestId("bot-settings");
  await expect(settings.getByRole("button", { name: "Edit name" })).toHaveText("Researcher");
  await expect(settings.getByTestId("bot-knowledge-memory")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "bot-settings-empty-memory");
});
