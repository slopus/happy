import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { blocksToAgentHistoryText } from "./attachments.js";
import { callIdFromClientNonce } from "./call-nonce.js";
import {
  callIsRinging,
  callRequestClientNonce,
  nextIncomingCall,
  phoneCallSettings,
  respondToIncomingCall,
  ringingCall,
} from "./call-request.js";

const NOW = Date.parse("2026-10-14T18:30:00Z");

function request(status: string, expiresAt = "2026-10-14T18:30:30Z"): MessageBlock {
  return {
    kind: "call_request",
    callId: `call-${status}`,
    reason: "3 reminders without a reply",
    opening: "You missed my reminders, so I'm calling.",
    status,
    expiresAt,
  } as MessageBlock;
}

describe("call requests", () => {
  it("carries the call id in its nonce, so the transcript groups it with the call", () => {
    expect(callIdFromClientNonce(callRequestClientNonce("abc"))).toBe("abc");
  });

  it("finds the call that is still ringing", () => {
    expect(
      ringingCall(
        [
          { role: "bot", blocks: [{ kind: "text", text: "Third reminder." }] },
          { role: "bot", blocks: [request("ringing")] },
        ],
        NOW,
      ),
    ).toEqual({
      callId: "call-ringing",
      reason: "3 reminders without a reply",
      opening: "You missed my reminders, so I'm calling.",
      expiresAt: "2026-10-14T18:30:30Z",
    });
  });

  it("ignores calls that rang out or already settled", () => {
    expect(
      ringingCall(
        [
          { role: "bot", blocks: [request("ringing", "2026-10-14T18:29:59Z")] },
          { role: "bot", blocks: [request("answered")] },
          { role: "bot", blocks: [request("missed")] },
          { role: "user", blocks: [request("ringing")] },
        ],
        NOW,
      ),
    ).toBeNull();
  });

  it("includes the spoken opening in answered history", () => {
    expect(blocksToAgentHistoryText([request("answered")])).toContain(
      "You missed my reminders, so I'm calling.",
    );
  });

  it("tells the bot how its call ended", () => {
    expect(blocksToAgentHistoryText([request("missed")])).toBe(
      "[you called the user about: 3 reminders without a reply; the user did not answer]",
    );
  });
});

describe("phone call server settings", () => {
  it("defaults to disabled, a two minute cooldown, and a 45 second ring", () => {
    expect(phoneCallSettings()).toEqual({
      phoneCallsEnabled: false,
      phoneCallCooldownMinutes: 2,
      phoneCallRingSeconds: 45,
    });
  });

  it("reads the worker settings with explicit opt-in", () => {
    expect(
      phoneCallSettings({
        PHONE_CALLS_ENABLED: "true",
        PHONE_CALL_COOLDOWN_MINUTES: "1",
        PHONE_CALL_RING_SECONDS: "90",
      }),
    ).toEqual({ phoneCallsEnabled: true, phoneCallCooldownMinutes: 1, phoneCallRingSeconds: 90 });
    for (const value of ["TRUE", "1", "false", ""]) {
      expect(phoneCallSettings({ PHONE_CALLS_ENABLED: value }).phoneCallsEnabled).toBe(false);
    }
  });

  it.each(["", "0", "-1", "invalid", "NaN", "Infinity"])(
    "defaults invalid durations: %s",
    (value) => {
      expect(
        phoneCallSettings({ PHONE_CALL_COOLDOWN_MINUTES: value, PHONE_CALL_RING_SECONDS: value }),
      ).toMatchObject({ phoneCallCooldownMinutes: 2, phoneCallRingSeconds: 45 });
    },
  );
});

describe("incoming call lifecycle", () => {
  it("uses one strict expiry boundary, including invalid timestamps", () => {
    expect(callIsRinging({ expiresAt: new Date(NOW).toISOString() }, NOW)).toBe(false);
    expect(callIsRinging({ expiresAt: "invalid" }, NOW)).toBe(false);
    expect(callIsRinging({ expiresAt: new Date(NOW + 1).toISOString() }, NOW)).toBe(true);
  });
  it("skips handled calls and selects the next live request", () => {
    const bots = ["first", "second"].map((callId) => ({
      incomingCall: { callId, expiresAt: new Date(NOW + 1000).toISOString() },
    }));
    expect(nextIncomingCall(bots, new Set(["first"]), NOW)).toBe(bots[1]);
    expect(nextIncomingCall(bots, new Set(), NOW + 1000)).toBeUndefined();
  });
  it("rejects stale actions before RPC and propagates authoritative server results", async () => {
    const send = vi.fn(async () => ({ opening: "Hello" }));
    await expect(
      respondToIncomingCall({ expiresAt: new Date(0).toISOString() }, send),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    await expect(
      respondToIncomingCall({ expiresAt: new Date(Date.now() + 10000).toISOString() }, send),
    ).resolves.toEqual({ opening: "Hello" });
  });
});
