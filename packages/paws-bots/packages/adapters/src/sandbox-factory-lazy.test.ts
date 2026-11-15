import { describe, expect, it, vi } from "vitest";

// Fail on module evaluation, rather than merely checking which provider was returned.
vi.mock("./wuying-sandbox.js", () => {
  throw new Error("Wuying loaded on default path");
});
vi.mock("@alicloud/ecd20200930", () => {
  throw new Error("ECD loaded on default path");
});
vi.mock("@alicloud/appstream-center20210218", () => {
  throw new Error("Appstream loaded on default path");
});
vi.mock("@alicloud/openapi-core", () => {
  throw new Error("OpenAPI loaded on default path");
});
vi.mock("@darabonba/typescript", () => {
  throw new Error("Darabonba loaded on default path");
});
vi.mock("railway", () => {
  throw new Error("Railway SDK loaded on default path");
});
vi.mock("@boatdev/sdk", () => {
  throw new Error("Boat SDK loaded on default path");
});
vi.mock("@boxd-sh/sdk", () => {
  throw new Error("boxd SDK loaded on default path");
});
vi.mock("@insforge/instabox-sdk", () => {
  throw new Error("instabox SDK loaded on default path");
});
vi.mock("@daytona/sdk", () => {
  throw new Error("Daytona SDK loaded on default path");
});
vi.mock("@chat-adapter/teams", () => {
  throw new Error("Teams adapter loaded before use");
});
vi.mock("@chat-adapter/slack", () => {
  throw new Error("Slack adapter loaded before use");
});
vi.mock("chat-adapter-sendblue", () => {
  throw new Error("Sendblue adapter loaded before use");
});

import { createRunSandbox, messagingPlatformsFromEnv } from "./index.js";
import { createSandboxProvider } from "./sandbox-factory.js";

describe("optional provider loading", () => {
  it("does not evaluate optional sandbox SDK modules through the default factory or barrel", async () => {
    expect(
      (
        await createSandboxProvider("docker", {
          wuyingAccessKeyId: "fake-key",
          wuyingAccessKeySecret: "fake-secret",
          wuyingDesktopId: "ecd-fake",
          wuyingEndUserId: "fake-user",
          wuyingMcpUrl: "https://gateway.example.test/mcp",
          wuyingMcpToken: "fake-token",
        })
      ).describe().id,
    ).toBe("docker");
    expect((await createRunSandbox("none", {})).describe().id).toBe("none");
    expect((await createSandboxProvider("wuying", {})).describe().id).toBe("none");
    for (const kind of ["daytona", "boat", "boxd", "instabox"]) {
      expect((await createSandboxProvider(kind, {})).describe().id).toBe("none");
    }
  });

  it("mounts Teams, Slack and Sendblue without loading their adapters until first use", () => {
    const [sendblue, slack, teams] = messagingPlatformsFromEnv({
      sendblueApiKeyId: "fake-key",
      sendblueApiSecret: "fake-secret",
      sendblueSigningSecret: "fake-signing-secret",
      sendbluePhoneNumber: "+15550000000",
      teamsAppId: "fake-app",
      teamsAppPassword: "fake-secret",
      teamsAppTenantId: "fake-tenant",
      slackBotToken: "xoxb-fake",
      slackSigningSecret: "fake-signing-secret",
    });
    expect([sendblue?.provider, slack?.provider]).toEqual(["sendblue", "slack"]);
    expect(sendblue!.adapter.isDM?.(sendblue!.directThreadId!("+15551234567"))).toBe(true);
    expect(slack!.adapter.name).toBe("slack");
    expect(teams!.adapter.name).toBe("teams");
  });
});
