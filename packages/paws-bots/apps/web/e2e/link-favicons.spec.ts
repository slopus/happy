import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

// Icons the API would have fetched; the test stands in for it so CI never contacts a real site.
const icons: Record<string, string> = {
  "https://x.example.test":
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAk1BMVEURERETExMQEBASEhIQEBAREREREREQEBBMaXEQEBAQEBARERERERERERERERH///9nZ2doaGgSEhJ4eHj39/eWlpbJycn8/PwmJibe3t7q6uojIyNFRUXb29sxMTFYWFg0NDT9/f3s7OxeXl4UFBQTExO3t7eysrIaGhoYGBjNzc3IyMhHR0dCQkL19fVycnJ5eXmjkUUsAAAADnRSTlMdJ6ocrK/u8gDxqe3s8MU5/BQAAAAJcEhZcwAACxMAAAsTAQCanBgAAADOSURBVDiNjZPnEsIgEIQvGk1RWUmzxVijxv7+T+dEJyZjgHN/AfsN3C1ALtmO0MjpWS7RQBjUJ7JNvhAd0u7/kUeC0d9AMB4H9WpjVgESiGsgBmQbQFj5IdpAfgQ2u894NQEO+98iiwsQXcvR7Q6cT+0uFktguxYimwOzqarN7O1UnCqHNAKSBIhSRQ7f6upaVUmGaHarAB4l8NQDK+aIlCkyY9pcMEEVTNQ5d1mSu27JPRj2yWnFA8zHGVHPDPhk9U3+sEsudTyd7fld9wUHZD2tj6fJ8AAAAABJRU5ErkJggg==",
  "https://www.docs.example.test":
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAq1BMVEVMaXEvbt4ubOAubt0ub90vbt0vb94AAP8vb90vbt4vbt4vbd8ubt0tcN0vb90ubt4wbd4vbt4ubt4vbt0vb90vbt0ubd8tcOAubt0vb98ubt0rbdoub94ub94ubt4vb98vb90vbt4wbN4ub94ub9wtcN0xcNwtbtwvbd4ub94ub94vcNwxcdsub90ub94ubt0ubt0ucNwvbt////8vb976/P6buu/5+/6cu++O08doAAAAM3RSTlMA+SG/7NjzAde92UHWVMfJP+nEgYD0MTLGIFMj6n5/MILyL/pSPTQzVvHaOyS+VzyDQlE1yrfgAAAACXBIWXMAAAsTAAALEwEAmpwYAAAA60lEQVQ4ja2T5xKCMAyAGYIFUVABB+69V+N4/yfzrq2sNuedZ/4l33clbYKm/TGq64lpRREx2x0l3riQhlWvlnniQyEaRpGfm0UOULnmeW1e5gB6kHFjIHOAyiHtz1dxgO6n0xPPX3cq4v7glb44wOVpyil98grhwkqcmHFKRSlmwgUXQiaYuOAwYYcLFhNsXLCZMMWFLRNcXOD3PH5rso0LQyZ0cGHGn9rCntoTw6rz9CEN6/YZd0M97la6mD31wiTZSgW6zPVlfin38tLWimttdEvf70k/Tp9k2FuUMYs4dIhtE2c0VuJf4w0gWXeUasIjGgAAAABJRU5ErkJggg==",
};

// The scripted runtime echoes the first 180 characters of the prompt back as its reply.
const reply =
  "[Post](https://x.example.test/a/status/1) and [odds](https://x.example.test/a/status/2). Guide: https://www.docs.example.test/guide/start/ or [plain](https://plain.example.test/)";

test("links in a bot reply show the site icon the API resolved", async ({ page }, testInfo) => {
  const asked: string[] = [];
  await page.route("**/rpc/links/favicon", async (route) => {
    const { json } = route.request().postDataJSON() as { json: { origin: string } };
    asked.push(json.origin);
    await route.fulfill({ json: { json: { icon: icons[json.origin] ?? null } } });
  });
  // The browser must never contact a linked site for its icon.
  const direct: string[] = [];
  await page.route(/^https?:\/\/[^/]*example\.test\//, async (route) => {
    direct.push(route.request().url());
    await route.abort();
  });

  await signup(page, `link-favicons-${Date.now()}@rakazo.test`, "password12", "Link Icons");
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill(reply);
  await composer.press("Enter");
  const bubble = page.getByTestId("message-bot-bubble").last();

  const post = bubble.getByRole("link", { name: "Post", exact: true });
  await expect(post).toBeVisible({ timeout: 20_000 });
  await expect(post).toHaveAttribute("href", "https://x.example.test/a/status/1");
  await expect(post.locator("img")).toHaveAttribute("src", icons["https://x.example.test"]!);
  await expect(post.locator("[aria-hidden='true']")).toHaveCount(1);

  const guide = bubble.getByRole("link", { name: "docs.example.test/guide/start" });
  await expect(guide).toHaveAttribute("href", "https://www.docs.example.test/guide/start/");
  await expect(guide.locator("img")).toBeVisible();

  const plain = bubble.getByRole("link", { name: "plain", exact: true });
  await expect(plain.locator("svg")).toBeVisible();
  await expect(plain.locator("img")).toHaveCount(0);

  // Only origins reach the API, once each, and nothing reaches the sites themselves.
  await expect
    .poll(() => [...asked].sort())
    .toEqual([
      "https://plain.example.test",
      "https://www.docs.example.test",
      "https://x.example.test",
    ]);
  expect(direct).toEqual([]);

  await bubble.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "link-favicons-bot-reply");
});
