import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ApnsTransport } from "./apns-voip.js";
import { ApnsVoipProvider } from "./apns-voip.js";
import { apnsVoipConfig } from "./apns-voip-config.js";

const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const config = {
  keyId: "test-key",
  teamId: "test-team",
  privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  environment: "sandbox" as const,
  bundleId: "test.app",
};
const call = {
  callId: "call-1",
  botId: "bot-1",
  botName: "Caller",
  expiresAt: new Date(Date.now() + 45_000).toISOString(),
};

describe("APNs VoIP", () => {
  it("constructs an expiring HTTP/2 VoIP request and a valid ES256 token", async () => {
    const transport = vi.fn<ApnsTransport>().mockResolvedValue({ status: 200 });
    const push = new ApnsVoipProvider(config, transport);
    expect(
      await push.send("fake-device-token", { ...call, secret: "must not be sent" } as typeof call),
    ).toBe("sent");
    const [origin, headers, body] = transport.mock.calls[0]!;
    expect(origin).toBe("https://api.sandbox.push.apple.com");
    expect(headers).toMatchObject({
      ":method": "POST",
      ":path": "/3/device/fake-device-token",
      "apns-topic": "test.app.voip",
      "apns-push-type": "voip",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(Date.parse(call.expiresAt) / 1000)),
    });
    expect(JSON.parse(body)).toEqual({ aps: {}, ...call });
    expect(body).not.toContain("secret");
    expect(body).not.toContain("PRIVATE KEY");
    await push.send("another-fake-token", call);
    expect(transport.mock.calls[1]![1].authorization).toBe(headers.authorization);
    const jwt = headers.authorization!.slice("bearer ".length).split(".");
    expect(
      verify(
        "sha256",
        Buffer.from(`${jwt[0]}.${jwt[1]}`),
        { key: keys.publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(jwt[2]!, "base64url"),
      ),
    ).toBe(true);
  });
  it.each([
    [{ status: 410 }, "invalid"],
    [{ status: 400, reason: "Unregistered" }, "invalid"],
    // Also returned for a sandbox/production mismatch, which must not drop every token.
    [{ status: 400, reason: "BadDeviceToken" }, "unavailable"],
  ] as const)("classifies %j as %s", async (reply, result) => {
    expect(await new ApnsVoipProvider(config, async () => reply).send("fake", call)).toBe(result);
  });
  it("does not deliver expired calls; transient errors permit fallback", async () => {
    const transport = vi.fn<ApnsTransport>().mockRejectedValue(new Error("offline"));
    const push = new ApnsVoipProvider(config, transport);
    expect(await push.send("fake", { ...call, expiresAt: new Date(0).toISOString() })).toBe(
      "unavailable",
    );
    expect(transport).not.toHaveBeenCalled();
    expect(await push.send("fake", call)).toBe("unavailable");
  });
  it("is optional and validates incomplete configuration without exposing values", () => {
    expect(apnsVoipConfig({})).toBeUndefined();
    expect(() => apnsVoipConfig({ APNS_VOIP_KEY_ID: "private-value" })).toThrow(
      "must be configured together",
    );
    expect(
      apnsVoipConfig({
        APNS_VOIP_KEY_ID: "test-key",
        APNS_VOIP_TEAM_ID: "test-team",
        APNS_VOIP_PRIVATE_KEY: "test-key-contents",
      }),
    ).toMatchObject({ environment: "production", bundleId: "com.rakazo.app" });
  });
});
