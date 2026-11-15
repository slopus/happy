import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Routine } from "@rakazo/contracts";
import { activeBotId, completeOnboarding, createNamedBot, rpc, signup } from "./helpers";

async function openComposer(page: Page, prefix: string) {
  await signup(page, `${prefix}-${Date.now()}@rakazo.test`, "password12", "Draft Keeper");
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: /Message/ });
  await expect(composer).toBeVisible();
  return composer;
}

async function createRoutine(page: Page, name: string) {
  return rpc<Routine>(page, "routines/create", {
    botId: activeBotId(page),
    name,
    prompt: "Summarize today",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: false,
    notify: false,
  });
}

async function mentionRoutine(page: Page, composer: Locator, name: string) {
  await composer.pressSequentially(`@${name.slice(0, 4)}`);
  await expect(page.getByRole("option", { name: `@${name}` })).toBeVisible();
  await composer.press("Enter");
}

test("a routine that already ran is not put back when the thread refresh fails", {
  tag: "@nightly",
}, async ({ page }) => {
  const composer = await openComposer(page, "send-failure-routine");
  await createRoutine(page, "daily-digest");
  await page.reload();
  await mentionRoutine(page, composer, "daily-digest");
  const chip = page.getByTestId("mention-chip");
  await expect(chip).toHaveText("@daily-digest");

  const ran = page.waitForResponse(
    (response) => response.url().includes("/rpc/threads/sendWithRoutines") && response.ok(),
  );
  const refreshFailed = page.waitForEvent("requestfailed", (request) =>
    request.url().includes("/rpc/threads/get"),
  );
  await page.route("**/rpc/threads/get", (route) => route.abort("internetdisconnected"));
  await composer.press("Enter");
  await ran;
  await refreshFailed;

  // The server took the send and the routine ran, so the send counts as done even though
  // the refresh after it failed: no error, and nothing comes back for a retry that would
  // run the routine twice.
  await expect(chip).toHaveCount(0);
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("composer-error")).toHaveCount(0);
});

test("a failed send with routines gives back the message and its routines", {
  tag: "@nightly",
}, async ({ page }) => {
  const composer = await openComposer(page, "send-failure-routines");
  await createRoutine(page, "daily-digest");
  await createRoutine(page, "weekly-review");
  await page.reload();
  await mentionRoutine(page, composer, "daily-digest");
  await mentionRoutine(page, composer, "weekly-review");
  await composer.pressSequentially("and the notes");
  const draft = await composer.inputValue();

  await page.route("**/rpc/threads/sendWithRoutines", (route) =>
    route.abort("internetdisconnected"),
  );
  await composer.press("Enter");

  await expect(page.getByTestId("composer-error")).toBeVisible();
  await expect(page.getByTestId("mention-chip")).toHaveCount(2);
  await expect(composer).toHaveValue(draft);
});

test("an unchanged routine retry after a lost response reuses the run", {
  tag: "@nightly",
}, async ({ page }) => {
  const composer = await openComposer(page, "send-lost-routine");
  await createRoutine(page, "daily-digest");
  await page.reload();
  await mentionRoutine(page, composer, "daily-digest");
  const nonces: string[] = [];
  const runIds: string[] = [];
  await page.route("**/rpc/threads/sendWithRoutines", async (route) => {
    nonces.push(route.request().postDataJSON().json.clientNonce);
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    runIds.push(...(await response.json()).json.routineRunIds);
    if (nonces.length === 1) await route.abort("internetdisconnected");
    else await route.fulfill({ response });
  });
  await composer.press("Enter");
  await expect(page.getByTestId("composer-error")).toBeVisible();
  await expect(page.getByTestId("mention-chip")).toHaveText("@daily-digest");
  const retryResponse = page.waitForResponse(
    (response) => response.url().includes("/rpc/threads/sendWithRoutines") && response.ok(),
  );
  await composer.press("Enter");
  await retryResponse;
  await expect(page.getByTestId("composer-error")).toBeHidden();
  await expect(page.getByTestId("mention-chip")).toHaveCount(0);
  expect(nonces).toHaveLength(2);
  expect(nonces[1]).toBe(nonces[0]);
  expect(runIds[1]).toBe(runIds[0]);
});

test("an accepted send clears recovered text after returning to the thread", {
  tag: "@nightly",
}, async ({ page }) => {
  await openComposer(page, "pending-return");
  await createNamedBot(page, "Other thread");
  const sidebar = page.locator("aside").first();
  await sidebar.getByRole("button", { name: /^Chief/ }).click();
  const composer = page.getByRole("combobox", { name: "Message Chief", exact: true });
  let releaseSend = () => {};
  const released = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  await page.route("**/rpc/threads/send", async (route) => {
    await released;
    await route.continue();
  });
  await composer.fill("pending accepted message");
  const request = page.waitForRequest("**/rpc/threads/send");
  await composer.press("Enter");
  await request;
  await expect(composer).toHaveValue("");
  await sidebar.getByRole("button", { name: /^Other thread/ }).click();
  await sidebar.getByRole("button", { name: /^Chief/ }).click();
  await expect(composer).toHaveValue("pending accepted message");
  releaseSend();
  await expect(composer).toHaveValue("");
  await page.reload();
  await expect(composer).toHaveValue("");
});

test("separate picks with matching file metadata upload their own bytes", {
  tag: "@nightly",
}, async ({ page }) => {
  const composer = await openComposer(page, "attachment-identity");
  const uploads: string[] = [];
  await page.route("**/rpc/artifacts/create", async (route) => {
    uploads.push(route.request().postDataJSON().json.contentBase64);
    await route.continue();
  });
  const metadata: Array<{ name: string; size: number; lastModified: number }> = [];
  for (const content of ["first", "other"]) {
    metadata.push(
      await page.locator('input[type="file"]').evaluate((element, text) => {
        const input = element as HTMLInputElement;
        const file = new File([text], "same.txt", {
          type: "text/plain",
          lastModified: 1234567890000,
        });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return { name: file.name, size: file.size, lastModified: file.lastModified };
      }, content),
    );
  }
  expect(metadata[0]).toEqual(metadata[1]);
  await composer.fill("Process both files");
  await composer.press("Enter");
  await expect(
    page.getByTestId("transcript").getByText("Process both files", { exact: true }),
  ).toBeVisible();
  expect(uploads).toEqual([
    Buffer.from("first").toString("base64"),
    Buffer.from("other").toString("base64"),
  ]);
});

test("a retried send after an edit reuses the attachment's uploaded artifact", {
  tag: "@nightly",
}, async ({ page }) => {
  const composer = await openComposer(page, "attachment-retry");
  const botId = activeBotId(page);
  const uploadNonces: string[] = [];
  await page.route("**/rpc/artifacts/create", async (route) => {
    uploadNonces.push(route.request().postDataJSON().json.clientNonce);
    await route.continue();
  });
  await page.locator('input[type="file"]').evaluate((element) => {
    const input = element as HTMLInputElement;
    const file = new File(["retry-me"], "notes.txt", { type: "text/plain" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await composer.fill("process the file");
  let sends = 0;
  await page.route("**/rpc/threads/send", async (route) => {
    sends += 1;
    if (sends === 1) await route.abort("internetdisconnected");
    else await route.continue();
  });
  await composer.press("Enter");
  await expect(page.getByTestId("composer-error")).toBeVisible();
  // Editing the draft gives the retry a new send nonce; the file is unchanged,
  // so its upload must replay the artifact the first attempt already stored.
  await composer.fill("process the file now");
  await composer.press("Enter");
  await expect(
    page.getByTestId("transcript").getByText("process the file now", { exact: true }),
  ).toBeVisible();

  expect(uploadNonces).toHaveLength(2);
  expect(uploadNonces[1]).toBe(uploadNonces[0]);
  const artifacts = await rpc<{ items: Array<{ name: string }> }>(page, "artifacts/listSpace", {
    botId,
    limit: 60,
  });
  expect(artifacts.items.filter((artifact) => artifact.name === "notes.txt")).toHaveLength(1);
});
