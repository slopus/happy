import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpoPushProvider } from "./expo-push.js";
import type { CallPushDevice, PushTokenStore } from "./push-token-store.js";

const call = {
  callId: "call-1",
  botId: "bot-1",
  botName: "Caller",
  expiresAt: new Date(Date.now() + 45_000).toISOString(),
};
function fixture() {
  const device: CallPushDevice = {
    deviceId: "installation-1",
    userId: "user-1",
    sessionId: "session-1",
    revision: "encrypted",
    platform: "ios",
    expoToken: "ExponentPushToken[fake]",
    voipToken: "fake-voip-token",
  };
  const tokens = {
    devices: vi.fn(async () => [device]),
    removeDevice: vi.fn(async () => {}),
    load: vi.fn(async () => undefined),
  } as unknown as PushTokenStore;
  const voip = { send: vi.fn(async (): Promise<"sent" | "invalid" | "unavailable"> => "sent") };
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response(JSON.stringify({ data: { status: "ok" } }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetch);
  const sessions = vi.fn(async () => new Date(Date.now() + 60_000));
  return {
    device,
    tokens,
    voip,
    fetch,
    sessions,
    provider: new ExpoPushProvider(tokens, { voip, sessionExpiresAt: sessions }),
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("incoming call delivery", () => {
  it("sends VoIP only to the authenticated owner's iOS devices", async () => {
    const { provider, voip, tokens, fetch } = fixture();
    await provider.incomingCall("user-1", call);
    expect(tokens.devices).toHaveBeenCalledWith("user-1");
    expect(voip.send).toHaveBeenCalledWith("fake-voip-token", call);
    expect(fetch).not.toHaveBeenCalled();
    await provider.incomingCall("another-user", call);
    expect(voip.send).toHaveBeenCalledTimes(1);
  });
  it.each(["unavailable", "invalid"] as const)(
    "falls back from %s without content or credentials",
    async (result) => {
      const { provider, voip, fetch, tokens } = fixture();
      voip.send.mockResolvedValue(result);
      await provider.incomingCall("user-1", call);
      expect(tokens.devices).toHaveBeenCalledTimes(2);
      const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
      expect(body).toMatchObject({
        priority: "high",
        interruptionLevel: "time-sensitive",
        categoryId: "incoming-call",
        data: { kind: "incoming_call", ...call },
      });
      expect(body.data).toEqual({ kind: "incoming_call", ...call });
      expect(body.ttl).toBeGreaterThan(0);
      if (result === "invalid")
        expect(tokens.removeDevice).toHaveBeenCalledWith(
          "user-1",
          "installation-1",
          "encrypted",
          "voip",
        );
    },
  );
  it("uses Expo when APNs is not configured and data-only pushes on Android", async () => {
    const { device, tokens, sessions, fetch } = fixture();
    device.platform = "android";
    await new ExpoPushProvider(tokens, { sessionExpiresAt: sessions }).incomingCall("user-1", call);
    const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({ priority: "high", data: { kind: "incoming_call", ...call } });
    expect(body.title).toBeUndefined();
    expect(body.body).toBeUndefined();
  });
  it("stops the ring only through Android data pushes, since every VoIP push rings", async () => {
    const { provider, device, voip, fetch } = fixture();
    const ended = { ...call, ended: true as const };
    await provider.incomingCall("user-1", ended);
    expect(voip.send).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    device.platform = "android";
    await provider.incomingCall("user-1", ended);
    const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(body.data).toEqual({ kind: "incoming_call_ended", ...call });
  });
  it("ignores expired calls, revoked sessions, and registrations changed during authorization", async () => {
    const { provider, voip, fetch, sessions, tokens } = fixture();
    await provider.incomingCall("user-1", { ...call, expiresAt: new Date(0).toISOString() });
    sessions.mockResolvedValue(new Date(0));
    await provider.incomingCall("user-1", call);
    sessions.mockResolvedValue(new Date(Date.now() + 60_000));
    vi.mocked(tokens.devices!)
      .mockResolvedValueOnce([{ ...(await tokens.devices!("user-1"))[0]!, revision: "old" }])
      .mockResolvedValue([]);
    await provider.incomingCall("user-1", call);
    expect(voip.send).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("removes both invalid transports against the same registration revision", async () => {
    const { provider, voip, fetch, tokens } = fixture();
    voip.send.mockResolvedValue("invalid");
    fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { status: "error", details: { error: "DeviceNotRegistered" } },
        }),
        { status: 200 },
      ),
    );
    await provider.incomingCall("user-1", call);
    expect(tokens.devices).toHaveBeenCalledTimes(2);
    expect(tokens.removeDevice).toHaveBeenCalledExactlyOnceWith(
      "user-1",
      "installation-1",
      "encrypted",
      undefined,
    );
  });
  it("uses the same visible payload for legacy registrations without a native channel override", async () => {
    const { provider, tokens, fetch } = fixture();
    vi.mocked(tokens.devices!).mockResolvedValue([]);
    vi.mocked(tokens.load).mockResolvedValue({ token: "ExponentPushToken[legacy]" });
    await provider.incomingCall("user-1", call);
    const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({ title: call.botName, data: { kind: "incoming_call", ...call } });
    expect(body.channelId).toBeUndefined();
    expect(body.ttl).toBeGreaterThan(0);
  });
  it("removes only the invalid Expo transport", async () => {
    const { provider, device, fetch, tokens } = fixture();
    device.platform = "android";
    fetch.mockResolvedValue(
      new Response(
        JSON.stringify({ data: { status: "error", details: { error: "DeviceNotRegistered" } } }),
        { status: 200 },
      ),
    );
    await provider.incomingCall("user-1", call);
    expect(tokens.removeDevice).toHaveBeenCalledWith(
      "user-1",
      "installation-1",
      "encrypted",
      "expo",
    );
  });
});
