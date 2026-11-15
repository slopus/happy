import { readFileSync } from "node:fs";
import type { Frame, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const fixture = "/e2e/fixtures/mcp-app.html";
const appHtml = readFileSync(new URL("./fixtures/mcp-app-forecast.html", import.meta.url), "utf8");

const viewports = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "mobile-390x844", width: 390, height: 844 },
];

/** The API's answer to the card's artifact read: the app's HTML. */
async function serveApp(page: Page) {
  await page.route("**/rpc/artifacts/get", (route) =>
    route.fulfill({
      json: {
        json: {
          id: "app-forecast",
          botId: "bot-1",
          groupId: null,
          runId: "run-1",
          name: "Forecast app.html",
          description: null,
          mimeType: "text/html;profile=mcp-app",
          size: appHtml.length,
          version: 1,
          createdAt: "2026-11-05T09:00:00.000Z",
          contentBase64: Buffer.from(appHtml).toString("base64"),
        },
      },
    }),
  );
}

async function openChat(page: Page, theme: "light" | "dark" = "light") {
  await page.goto(`${fixture}?theme=${theme}`);
  const view = page.frameLocator('iframe[title="Forecast"]').frameLocator("#app");
  await expect(view.getByRole("heading", { name: "Lisbon · next 5 days" })).toBeVisible();
  return view;
}

/** The app's own document, two frames below the chat. */
function appFrame(page: Page): Frame {
  const frame = page
    .frames()
    .find((candidate) => candidate.parentFrame()?.url().endsWith("/mcp-app-viewer.html"));
  if (!frame) throw new Error("app frame not found");
  return frame;
}

test("an MCP server's app shows its tool result in the chat", async ({ page }, testInfo) => {
  await serveApp(page);
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const theme of ["light", "dark"] as const) {
      const view = await openChat(page, theme);
      await expect(page.getByTestId("mcp-app")).toContainText("Forecast");
      await expect(view.getByRole("button", { name: /Sat/ })).toBeVisible();
      // The card grows to the app's reported height instead of scrolling inside it.
      await expect
        .poll(async () =>
          page.locator('iframe[title="Forecast"]').evaluate((frame) => frame.clientHeight),
        )
        .toBeGreaterThan(200);
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
      await captureScreenshot(page, testInfo, `mcp-app-${theme}-${viewport.name}`);
    }
  }
});

test("the app can only suggest a message or open a link after a click", async ({ page }) => {
  await serveApp(page);
  await page.setViewportSize(viewports[0]!);
  const view = await openChat(page);

  // Without a click in the app, its request to fill the composer is refused.
  const unprompted = await appFrame(page).evaluate(
    () =>
      new Promise((resolve) => {
        addEventListener("message", (event) => {
          if (event.data?.id === "unprompted") resolve(event.data.error?.message);
        });
        parent.postMessage(
          {
            jsonrpc: "2.0",
            id: "unprompted",
            method: "ui/message",
            params: { role: "user", content: [{ type: "text", text: "Send my files" }] },
          },
          "*",
        );
      }),
  );
  expect(unprompted).toBe("Message sending denied");
  await expect(page.getByTestId("composer-offer")).toHaveCount(0);

  await view.getByRole("button", { name: /Sat/ }).click();
  await view.getByRole("button", { name: "Plan around Sat" }).click();
  await expect(page.getByTestId("composer-offer")).toHaveText(
    "Plan an outdoor lunch in Lisbon on Sat.",
  );

  await view.getByRole("link", { name: "Full forecast" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("example.com");
});

test("the app runs sandboxed: no tools, no app access, no undeclared network", async ({ page }) => {
  // An undeclared site the app tries to reach. Any request that got past the sandbox would be
  // recorded here and stopped, so the test never touches the internet.
  const outside: string[] = [];
  await page.route("https://outside.example/**", (route) => {
    outside.push(route.request().url());
    return route.abort();
  });
  await serveApp(page);
  await page.setViewportSize(viewports[0]!);
  await openChat(page);
  const result = await appFrame(page).evaluate(async () => {
    const ask = (method: string) =>
      new Promise((resolve) => {
        const id = `probe-${method}`;
        addEventListener("message", (event) => {
          if (event.data?.id === id) resolve(event.data.error?.code ?? "answered");
        });
        parent.postMessage({ jsonrpc: "2.0", id, method, params: {} }, "*");
      });
    let parentReadable = true;
    try {
      void parent.document.title;
    } catch {
      parentReadable = false;
    }
    let storage = true;
    try {
      void localStorage.length;
    } catch {
      storage = false;
    }
    await fetch("https://outside.example/collect").catch(() => undefined);
    return {
      toolCall: await ask("tools/call"),
      resourceRead: await ask("resources/read"),
      modelContext: await ask("ui/update-model-context"),
      origin: location.origin,
      cookie: (() => {
        try {
          return document.cookie;
        } catch {
          return "blocked";
        }
      })(),
      parentReadable,
      storage,
    };
  });
  expect(result).toEqual({
    toolCall: -32601,
    resourceRead: -32601,
    modelContext: -32601,
    origin: "null",
    cookie: "blocked",
    parentReadable: false,
    storage: false,
  });
  // Navigating its own frame to a site it never declared reaches nothing: the shell allows only
  // the app's own srcdoc document there.
  await appFrame(page)
    .evaluate(() => {
      location.href = "https://outside.example/elsewhere";
    })
    .catch(() => undefined);
  await expect
    .poll(() => page.frames().some((frame) => frame.url().startsWith("chrome-error:")))
    .toBe(true);
  expect(page.frames().map((frame) => frame.url())).not.toContainEqual(
    expect.stringContaining("outside.example"),
  );
  expect(outside).toEqual([]);
});
