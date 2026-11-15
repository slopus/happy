import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("peer conversation shows charts and retains unavailable page cards", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/threads/messages", (route) =>
    route.fulfill({
      json: {
        json: {
          messages: [
            {
              id: "wake",
              role: "bot",
              runId: "run",
              createdAt: "2026-01-01T00:00:00Z",
              blocks: [
                {
                  kind: "bot_message_received",
                  fromBotId: "peer",
                  fromBotName: "Researcher",
                  text: "Summarize the readings",
                },
              ],
            },
            {
              id: "chart",
              role: "bot",
              runId: "run",
              createdAt: "2026-01-01T00:00:01Z",
              blocks: [
                {
                  kind: "chart",
                  name: "Readings",
                  spec: {
                    title: "Readings",
                    marks: [{ type: "barY", options: { x: "label", y: "value" } }],
                  },
                  data: [
                    { label: "A", value: 2 },
                    { label: "B", value: 3 },
                  ],
                },
              ],
            },
            {
              id: "page",
              role: "bot",
              runId: "run",
              createdAt: "2026-01-01T00:00:02Z",
              blocks: [
                { kind: "text", text: "The report is ready." },
                { kind: "page", pageId: "report", title: "Daily report", version: 1 },
              ],
            },
          ],
          olderCursor: null,
        },
      },
    }),
  );
  // Rendering a page card must not bypass the existing page-read boundary.
  await page.route("**/rpc/pages/get", (route) => route.fulfill({ status: 403 }));
  await page.goto("/e2e/fixtures/peer-rich-replies.html");
  const view = page.getByTestId("peer-conversation-view");
  await expect(view.getByText("The report is ready.")).toBeVisible();
  await expect(view.getByText("Daily report", { exact: true })).toBeVisible();
  await expect(view.getByText("This page couldn't load", { exact: true })).toBeVisible();
  await expect(
    view.getByRole("button", { name: "Expand", exact: true }).locator("..").locator("svg"),
  ).toBeVisible();
  await expect(view.getByRole("button", { name: "Expand", exact: true })).toHaveCount(1);
  await captureScreenshot(page, testInfo, "peer-rich-replies");
});
