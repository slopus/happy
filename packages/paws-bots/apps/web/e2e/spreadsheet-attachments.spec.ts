import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Artifact, ArtifactWithContent } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("Excel files can be attached and uploaded without losing their bytes", async ({
  page,
}, testInfo) => {
  await signup(page, `spreadsheet-${Date.now()}@rakazo.test`, "password12", "Sheet Reader");
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: /Message/ });
  await expect(composer).toBeVisible();
  const files = [
    { name: "statement.xls", mimeType: "application/octet-stream" },
    { name: "statement.xlsx", mimeType: "" },
  ].map((file) => ({
    ...file,
    buffer: readFileSync(path.join(import.meta.dirname, "fixtures", file.name)),
  }));
  await page.locator('input[type="file"]').setInputFiles(files);
  for (const file of files) {
    await expect(
      page.getByRole("button", { name: `Remove ${file.name}`, exact: true }),
    ).toBeVisible();
  }
  await captureScreenshot(page, testInfo, "excel-attachments-ready");
  await composer.fill("Here are the current statements");
  await composer.press("Enter");
  await expect(
    page.getByTestId("transcript").getByText("Here are the current statements", { exact: true }),
  ).toBeVisible();
  const artifacts = await rpc<Artifact[]>(page, "artifacts/list", { botId: activeBotId(page) });
  for (const [index, file] of files.entries()) {
    const artifact = artifacts.find((item) => item.name === file.name);
    expect(artifact).toBeDefined();
    expect(artifact?.mimeType).toBe(
      [
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ][index],
    );
    const stored = await rpc<ArtifactWithContent>(page, "artifacts/getById", {
      artifactId: artifact!.id,
    });
    expect(stored.contentBase64).toBe(file.buffer.toString("base64"));
  }
});
