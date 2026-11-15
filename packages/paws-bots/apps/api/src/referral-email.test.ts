import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHourlySweep } from "./hourly-sweep.js";
import { unsubscribeUrl } from "./marketing-email.js";
import { sendReferralEmails } from "./referral-email.js";

const DAY = 86_400_000;
const now = new Date("2026-10-29T12:00:00Z");
const secret = "test-auth-secret-at-least-32-characters";
const origin = "https://app.example.com";

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const sent = new Set<string>();
  const user = {
    id: "user-1",
    email: "alex@example.com",
    name: "Alex",
    members: [{ role: "owner" }],
  };
  const findMany = vi.fn(async () => [user]);
  const createMany = vi.fn(async ({ data }: { data: { userId: string; kind: string } }) => {
    const key = `${data.userId}:${data.kind}`;
    if (sent.has(key)) return { count: 0 };
    sent.add(key);
    return { count: 1 };
  });
  const email = { send: vi.fn(async () => {}) } as unknown as TransactionalEmailProvider;
  const deps = {
    prisma: { user: { findMany }, emailSend: { createMany } } as never,
    email,
    appUrl: `${origin}/app`,
    origin,
    secret,
    onError: vi.fn(),
  };
  return { user, deps, findMany, createMany, sweep: sendReferralEmails(deps) };
}

afterEach(() => vi.useRealTimers());

describe("day-one referral email", () => {
  it("emails verified owners aged 24–72 hours with consent and no previous send", async () => {
    const f = fixture();
    await f.sweep();
    expect(f.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          createdAt: {
            gte: new Date(now.getTime() - 3 * DAY),
            lte: new Date(now.getTime() - DAY),
          },
          emailVerified: true,
          marketingEmailOptOutAt: null,
          members: { some: { role: { contains: "owner" } } },
          emailSends: { none: { kind: "referral-day1" } },
        },
      }),
    );
    expect(f.createMany).toHaveBeenCalledWith({
      data: { userId: "user-1", kind: "referral-day1" },
      skipDuplicates: true,
    });
    expect(f.deps.email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "alex@example.com",
        subject: "Invite a friend",
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl(origin, secret, "user-1")}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
    );
  });

  it("never sends twice across concurrent sweeps or a retry", async () => {
    const f = fixture();
    await Promise.all([f.sweep(), f.sweep()]);
    await sendReferralEmails(f.deps)();
    expect(f.deps.email.send).toHaveBeenCalledTimes(1);
  });

  it("keeps the claim after uncertain delivery instead of sending again", async () => {
    const f = fixture();
    vi.mocked(f.deps.email.send).mockRejectedValue(new Error("delivery failed"));
    await f.sweep();
    await f.sweep();
    expect(f.deps.email.send).toHaveBeenCalledTimes(1);
    expect(f.deps.onError).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a role that only contains owner", { members: [{ role: "not-owner" }] }],
    ["an unusable address", { email: "invalid@" }],
  ])("skips %s", async (_, change) => {
    const f = fixture();
    Object.assign(f.user, change);
    await f.sweep();
    expect(f.createMany).not.toHaveBeenCalled();
  });

  it("runs at startup and hourly without overlapping sweeps, aborting the running one on stop", async () => {
    vi.useFakeTimers();
    let finish: () => void = () => {};
    const sweep = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const stop = startHourlySweep(sweep, vi.fn());
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(sweep).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(sweep).toHaveBeenCalledTimes(2);
    const signal = sweep.mock.calls[1]![0];
    const stopped = stop();
    expect(signal.aborted).toBe(true);
    finish();
    await stopped;
  });
});
