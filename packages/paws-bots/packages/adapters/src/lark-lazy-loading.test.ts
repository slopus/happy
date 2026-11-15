import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const { implementationLoaded, sdkLoaded } = vi.hoisted(() => ({
  implementationLoaded: vi.fn(),
  sdkLoaded: vi.fn(),
}));
vi.mock("./lark/lark-adapter.js", async (original) => {
  implementationLoaded();
  return original();
});
vi.mock("@larksuiteoapi/node-sdk", async (original) => {
  sdkLoaded();
  return original();
});

import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import { messagingPlatformsFromEnv } from "./messaging-platforms.js";

describe("Lark lazy loading", () => {
  it("loads neither module without credentials, including when another surface mounts", async () => {
    expect(messagingPlatformsFromEnv({})).toEqual([]);
    const surface = new ChatSdkMessagingSurface(
      messagingPlatformsFromEnv({
        telegramBotToken: "test-token",
        telegramWebhookSecret: "test-secret",
      }),
    );
    expect(surface).toBeDefined();
    expect(implementationLoaded).not.toHaveBeenCalled();
    expect(sdkLoaded).not.toHaveBeenCalled();
    const [platform] = messagingPlatformsFromEnv({
      larkAppId: "test-app",
      larkAppSecret: "test-secret",
      larkVerificationToken: "test-token",
    });
    expect(platform?.provider).toBe("lark");
    expect(new ChatSdkMessagingSurface([platform!])).toBeDefined();
    expect(implementationLoaded).not.toHaveBeenCalled();
    expect(sdkLoaded).not.toHaveBeenCalled();
    // No network: an authenticated URL challenge exercises first-use loading.
    const response = await platform!.adapter.handleWebhook(
      new Request("https://example.test", {
        method: "POST",
        body: JSON.stringify({
          type: "url_verification",
          token: "test-token",
          challenge: "challenge",
        }),
      }),
    );
    expect(await response.json()).toEqual({ challenge: "challenge" });
    expect(implementationLoaded).toHaveBeenCalledTimes(1);
    expect(sdkLoaded).toHaveBeenCalledTimes(1);
    await platform!.adapter.handleWebhook(
      new Request("https://example.test", { method: "POST", body: "{}" }),
    );
    expect(implementationLoaded).toHaveBeenCalledTimes(1);
  });

  it("forbids static SDK value imports and keeps implementation imports inside the Lark boundary", () => {
    const root = new URL("../../../", import.meta.url);
    for (const dir of ["packages", "apps"]) {
      const base = new URL(`${dir}/`, root);
      for (const file of sourceFiles(base.pathname)) {
        if (
          !/\.[cm]?[jt]sx?$/.test(file) ||
          file.includes("node_modules") ||
          file.includes("/dist/") ||
          file.includes("/generated/") ||
          file.includes(".test.")
        )
          continue;
        const source = readFileSync(join(base.pathname, file), "utf8");
        expect(
          source.match(/import\s+(?!type\b)(?:[^;]*?from\s*)?["']@larksuiteoapi\/node-sdk["']/g),
          `${dir}/${file}`,
        ).toBeNull();
        if (!file.includes("/src/lark/")) {
          expect(
            source.match(/import\s+(?!type\b)[^;]*?from\s*["'][^"']*lark-adapter\.js["']/g),
            `${dir}/${file}`,
          ).toBeNull();
        }
      }
    }
  });
});

function* sourceFiles(directory: string, prefix = ""): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "generated", ".next", ".expo"].includes(entry.name)) continue;
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(join(directory, entry.name), path);
    else if (entry.isFile()) yield path;
  }
}
