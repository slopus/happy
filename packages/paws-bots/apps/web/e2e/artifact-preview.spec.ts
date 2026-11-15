import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("agent-attached files appear as cards with previews and downloads", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `artifact-card-${stamp}@rakazo.test`, "password12", "Artifact Card");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("write path notes/result.txt and attach it to the thread says Result notes");
  await page.keyboard.press("Enter");

  // Text files open in the viewer instead of downloading.
  const fileCard = page.getByRole("button", { name: "Preview result.txt" });
  await expect(fileCard).toBeVisible({ timeout: 30_000 });
  await captureScreenshot(page, testInfo, "current-file-card");
  await fileCard.click();

  const textDialog = page.getByRole("dialog", { name: "result.txt" });
  await expect(textDialog.getByText("Result notes")).toBeVisible();
  await captureScreenshot(page, testInfo, "text-preview-open");
  const downloadPromise = page.waitForEvent("download");
  await textDialog.getByRole("button", { name: "Download result.txt" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("result.txt");
  await page.keyboard.press("Escape");
  await expect(textDialog).toHaveCount(0);

  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });
  await composer.fill(
    "write path notes/preview.md and attach it to the thread says # Project preview",
  );
  await page.keyboard.press("Enter");

  const previewButton = page.getByRole("button", { name: "Preview preview.md" });
  await expect(previewButton).toBeVisible({ timeout: 30_000 });
  await captureScreenshot(page, testInfo, "markdown-file-card");
  let releasePreview = () => {};
  const previewReady = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  await page.route("**/rpc/artifacts/get", async (route) => {
    await previewReady;
    await route.continue();
  });
  await previewButton.click();

  const dialog = page.getByRole("dialog", { name: "preview.md" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("status", { name: "Loading preview…" })).toBeVisible();
  await expect(dialog).not.toContainText("Loading preview…");
  await captureScreenshot(page, testInfo, "markdown-preview-loading-spinner");
  releasePreview();
  await expect(dialog.getByRole("heading", { name: "Project preview" })).toBeVisible();
  const closeButton = dialog.getByRole("button", { name: "Close preview" });
  const downloadButton = dialog.getByRole("button", { name: "Download preview.md" });
  await expect(closeButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(downloadButton).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(closeButton).toBeFocused();
  await captureScreenshot(page, testInfo, "markdown-preview-open");

  const markdownDownloadPromise = page.waitForEvent("download");
  await downloadButton.click();
  const markdownDownload = await markdownDownloadPromise;
  expect(markdownDownload.suggestedFilename()).toBe("preview.md");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(previewButton).toBeFocused();

  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });
  await composer.fill(
    "write path notes/page.html and attach it to the thread says <h1>Rendered page</h1><p id=ran></p><script>document.getElementById('ran').textContent = 'script ran'</script>",
  );
  await page.keyboard.press("Enter");

  const htmlPreviewButton = page.getByRole("button", { name: "Preview page.html" });
  await expect(htmlPreviewButton).toBeVisible({ timeout: 30_000 });
  await htmlPreviewButton.click();

  const htmlDialog = page.getByRole("dialog", { name: "page.html" });
  await expect(htmlDialog).toBeVisible();
  // The viewer loads the network shell, which renders the document in a nested sandboxed frame.
  const shell = htmlDialog.locator('iframe[title="page.html"]');
  await expect(shell).toHaveAttribute("src", "/html-viewer.html");
  const preview = shell.contentFrame().locator("iframe#preview").contentFrame();
  await expect(preview.getByRole("heading", { name: "Rendered page" })).toBeVisible();
  await expect(preview.getByText("script ran")).toBeVisible();
  // The preview's opaque origin keeps it away from the app's storage and DOM.
  expect(await preview.locator("body").evaluate(() => window.origin)).toBe("null");
  await captureScreenshot(page, testInfo, "html-preview-open");
});
