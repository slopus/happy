import { describe, expect, it } from "vitest";
import {
  messagingConnectOptions,
  messagingProviderLabel,
  messagingProviderName,
} from "./messaging-providers.js";

describe("messaging provider labels", () => {
  it("names known providers and falls back to the raw id", () => {
    expect(messagingProviderName("sendblue")).toBe("iMessage");
    expect(messagingProviderName("telegram")).toBe("Telegram");
    expect(messagingProviderName("photon")).toBe("iMessage (Photon)");
    expect(messagingProviderName("teams")).toBe("teams");
  });

  it("names extra Telegram bots after their configured name", () => {
    expect(messagingProviderName("telegram-work")).toBe("Telegram (work)");
    expect(messagingProviderLabel("telegram-work")).toBe("Telegram (work)");
  });

  it("names extra Photon projects after their configured name", () => {
    expect(messagingProviderName("photon-pm")).toBe("iMessage (pm)");
    expect(messagingProviderLabel("photon-pm")).toBe("iMessage (pm)");
  });

  it("narrows iMessage to its transport", () => {
    expect(messagingProviderLabel("sendblue", "SMS")).toBe("SMS");
    expect(messagingProviderLabel("sendblue", "fax")).toBe("iMessage");
  });
});

it("offers Slack authorization once, including before a workspace is installed", () => {
  expect(messagingConnectOptions(["slack", "telegram", "slack"], true)).toEqual([
    { provider: "slack", method: "install" },
    { provider: "telegram", method: "link" },
  ]);
  expect(messagingConnectOptions([], true)).toEqual([{ provider: "slack", method: "install" }]);
  expect(messagingConnectOptions(["slack"], false)).toEqual([
    { provider: "slack", method: "link" },
  ]);
});
