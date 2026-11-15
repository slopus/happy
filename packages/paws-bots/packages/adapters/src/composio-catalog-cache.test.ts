import { execFile } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  createToolkitDirectoryCache,
  mergeCatalogWithConnected,
} from "./composio-catalog-cache.js";

describe("composio toolkit directory cache", () => {
  it("loads once within the TTL and coalesces inflight reads", async () => {
    let loads = 0;
    const cache = createToolkitDirectoryCache({ ttlMs: 60_000, now: () => 1_000 });
    const loader = async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [{ slug: "github", name: "GitHub", logo: null, noAuth: false }];
    };
    const [a, b] = await Promise.all([cache.get(loader), cache.get(loader)]);
    expect(loads).toBe(1);
    expect(a).toHaveLength(1);
    expect(b[0]?.slug).toBe("github");
    await cache.get(loader);
    expect(loads).toBe(1);
  });

  it("returns stale items while a TTL refresh runs", async () => {
    let now = 0;
    let loads = 0;
    const cache = createToolkitDirectoryCache({ ttlMs: 10, now: () => now });
    const first = await cache.get(async () => {
      loads += 1;
      return [{ slug: "gmail", name: "Gmail", logo: null, noAuth: false }];
    });
    expect(first[0]?.slug).toBe("gmail");
    now = 50;
    let resolveRefresh: (items: typeof first) => void = () => undefined;
    const refresh = new Promise<typeof first>((resolve) => {
      resolveRefresh = resolve;
    });
    const stale = await cache.get(() => {
      loads += 1;
      return refresh;
    });
    expect(stale[0]?.slug).toBe("gmail");
    expect(loads).toBe(2);
    resolveRefresh([{ slug: "slack", name: "Slack", logo: null, noAuth: false }]);
    await refresh;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const next = await cache.get(async () => {
      loads += 1;
      return [{ slug: "linear", name: "Linear", logo: null, noAuth: false }];
    });
    expect(next[0]?.slug).toBe("slack");
    expect(loads).toBe(2);
  });

  it("marks only connected slugs on the cached directory", () => {
    const items = mergeCatalogWithConnected(
      [
        { slug: "github", name: "GitHub", logo: null, noAuth: false },
        { slug: "hackernews", name: "Hacker News", logo: null, noAuth: true },
      ],
      ["HACKERNEWS"],
    );
    expect(items.find((item) => item.slug === "github")?.connected).toBe(false);
    expect(items.find((item) => item.slug === "hackernews")?.connected).toBe(true);
  });

  it("drops apps that need sign-in setup unless the user has an account for them", () => {
    const items = mergeCatalogWithConnected(
      [
        { slug: "shopify", name: "Shopify", logo: null, noAuth: false, needsSignInSetup: true },
        { slug: "twitter", name: "X", logo: null, noAuth: false, needsSignInSetup: true },
        { slug: "etsy", name: "Etsy", logo: null, noAuth: false, needsSignInSetup: true },
      ],
      ["twitter"],
      ["twitter", "ETSY"],
    );
    expect(items).toEqual([
      { slug: "twitter", name: "X", logo: null, noAuth: false, connected: true },
      { slug: "etsy", name: "Etsy", logo: null, noAuth: false, connected: false },
    ]);
  });

  it("handles detached refresh rejection in a real Node process", async () => {
    const moduleUrl = new URL("./composio-catalog-cache.ts", import.meta.url).href;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--unhandled-rejections=strict",
        "--import=tsx",
        "--input-type=module",
        "--eval",
        `
          import { setImmediate } from "node:timers/promises";
          import { createToolkitDirectoryCache } from ${JSON.stringify(moduleUrl)};
          let now = 0;
          const cache = createToolkitDirectoryCache({ ttlMs: 10, now: () => now });
          await cache.get(async () => []);
          now = 10;
          await cache.get(async () => { throw new Error("directory unavailable"); });
          await setImmediate();
          console.log("refresh failure handled");
        `,
      ],
      { timeout: 10_000, env: { ...process.env, NODE_OPTIONS: "" } },
    );
    expect(stdout.trim()).toBe("refresh failure handled");
  });

  it("keeps stale items after a failed refresh and retries on the next read", async () => {
    let now = 0;
    const cache = createToolkitDirectoryCache({ ttlMs: 10, now: () => now });
    const first = await cache.get(async () => [
      { slug: "gmail", name: "Gmail", logo: null, noAuth: false },
    ]);
    now = 10;
    let rejectRefresh: (error: Error) => void = () => undefined;
    const refresh = new Promise<typeof first>((_resolve, reject) => {
      rejectRefresh = reject;
    });
    const loader = vi.fn(() => refresh);

    expect(await cache.get(loader)).toBe(first);
    expect(await cache.get(loader)).toBe(first);
    expect(loader).toHaveBeenCalledTimes(1);
    rejectRefresh(new Error("directory unavailable"));
    await setImmediate();
    expect(cache.peek()).toBe(first);

    const updated = [{ slug: "slack", name: "Slack", logo: null, noAuth: false }];
    const retry = vi.fn(async () => updated);
    expect(await cache.get(retry)).toBe(first);
    await setImmediate();
    expect(await cache.get(retry)).toBe(updated);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it.each(["throw", "reject"])("propagates a cold-load %s and allows retry", async (failure) => {
    const cache = createToolkitDirectoryCache();
    const error = new Error("directory unavailable");
    await expect(
      cache.get(() => {
        if (failure === "throw") throw error;
        return Promise.reject(error);
      }),
    ).rejects.toBe(error);
    expect(cache.peek()).toBeUndefined();
    const items = [{ slug: "gmail", name: "Gmail", logo: null, noAuth: false }];
    expect(await cache.get(async () => items)).toBe(items);
  });
});
