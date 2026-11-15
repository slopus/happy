import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ApnsActivityProvider } from "./apns-activity.js";
import type { ApnsTransport } from "./apns-voip.js";

const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const config = {
  keyId: "test-key",
  teamId: "test-team",
  privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  environment: "production" as const,
  bundleId: "test.app",
};
const working = {
  count: 1,
  waiting: 0,
  rows: [
    {
      status: "working" as const,
      title: "Planner",
      line: "Searching",
      spaceId: "space-1",
      botId: "bot-1",
    },
  ],
};

describe("APNs work activity", () => {
  it("sends a step as a low priority Live Activity update", async () => {
    const transport = vi.fn<ApnsTransport>().mockResolvedValue({ status: 200 });
    const push = new ApnsActivityProvider(config, transport);
    expect(
      await push.send("fake-token", { state: working, ended: false, urgent: false, at: 1_000 }),
    ).toBe("sent");
    const [origin, headers, body] = transport.mock.calls[0]!;
    expect(origin).toBe("https://api.push.apple.com");
    expect(headers).toMatchObject({
      ":path": "/3/device/fake-token",
      "apns-topic": "test.app.push-type.liveactivity",
      "apns-push-type": "liveactivity",
      "apns-priority": "5",
      "apns-expiration": "1300",
    });
    expect(JSON.parse(body)).toEqual({
      aps: { timestamp: 1_000, event: "update", "content-state": working },
    });
  });

  it("shows urgent changes at once, and the end leaves straight away", async () => {
    const transport = vi.fn<ApnsTransport>().mockResolvedValue({ status: 200 });
    const push = new ApnsActivityProvider(config, transport);
    await push.send("fake-token", { state: working, ended: false, urgent: true, at: 1_000 });
    await push.send("fake-token", { state: working, ended: true, urgent: true, at: 1_001 });
    expect(transport.mock.calls.map(([, headers]) => headers["apns-priority"])).toEqual([
      "10",
      "10",
    ]);
    // An end waits for an offline phone; a step update is soon replaced.
    expect(transport.mock.calls.map(([, headers]) => headers["apns-expiration"])).toEqual([
      "1300",
      String(1_001 + 8 * 60 * 60),
    ]);
    expect(JSON.parse(transport.mock.calls[1]![2]).aps).toMatchObject({
      event: "end",
      "dismissal-date": 1_001,
    });
  });

  it("drops cards Apple no longer knows and keeps them through outages", async () => {
    const reply = vi.fn<ApnsTransport>();
    const push = new ApnsActivityProvider(config, reply);
    const send = () =>
      push.send("fake-token", { state: working, ended: false, urgent: false, at: 1_000 });
    reply.mockResolvedValueOnce({ status: 410, reason: "Unregistered" });
    expect(await send()).toBe("invalid");
    reply.mockResolvedValueOnce({ status: 400, reason: "BadDeviceToken" });
    expect(await send()).toBe("unavailable");
    reply.mockResolvedValueOnce({ status: 503, reason: "ServiceUnavailable" });
    expect(await send()).toBe("unavailable");
    reply.mockRejectedValueOnce(new Error("offline"));
    expect(await send()).toBe("unavailable");
  });

  it("starts a card with the phone's start token, asking iOS for the card's own token", async () => {
    const transport = vi.fn<ApnsTransport>().mockResolvedValue({ status: 200 });
    const push = new ApnsActivityProvider(config, transport);
    expect(
      await push.start("fake-start-token", {
        state: working,
        ended: false,
        urgent: true,
        at: 1_000,
      }),
    ).toBe("sent");
    const [, headers, body] = transport.mock.calls[0]!;
    expect(headers).toMatchObject({
      ":path": "/3/device/fake-start-token",
      "apns-topic": "test.app.push-type.liveactivity",
      "apns-push-type": "liveactivity",
      "apns-priority": "10",
    });
    expect(JSON.parse(body)).toEqual({
      aps: {
        timestamp: 1_000,
        event: "start",
        "attributes-type": "WorkActivityAttributes",
        attributes: {},
        "content-state": working,
        "input-push-token": 1,
        alert: { title: "Planner", body: "Searching" },
      },
    });
  });
});
