import type { BillingProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { BillingService } from "./billing.js";
import { BILLING_RETURN_PATH } from "./billing.js";
import {
  BILLING_WEBHOOK_MAX_BODY_BYTES,
  BILLING_WEBHOOK_PATH,
  mountBillingRoutes,
} from "./billing-webhook.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
};

function mount(
  parseWebhook: BillingProvider["parseWebhook"],
  options: { sync?: () => Promise<void>; actor?: Actor | null } = {},
) {
  const sync = vi.fn(options.sync ?? (async () => undefined));
  const syncForActor = vi.fn(async () => undefined);
  const app = new Hono();
  mountBillingRoutes(app, {
    billing: { sync, syncForActor } as unknown as BillingService,
    provider: { parseWebhook },
    webOrigin: "https://app.example.com",
    authenticate: async () => (options.actor === undefined ? actor : options.actor),
  });
  return { app, sync, syncForActor };
}

function post(body: string) {
  return { method: "POST", headers: { "stripe-signature": "t=1,v1=fake" }, body };
}

describe("billing webhook", () => {
  it("rejects a request whose signature does not verify", async () => {
    const { app, sync } = mount(() => null);
    const res = await app.request(BILLING_WEBHOOK_PATH, post("{}"));
    expect(res.status).toBe(400);
    expect(sync).not.toHaveBeenCalled();
  });

  it("rejects an oversized body before verifying it", async () => {
    const parseWebhook = vi.fn(() => null);
    const { app } = mount(parseWebhook);
    const res = await app.request(
      BILLING_WEBHOOK_PATH,
      post("x".repeat(BILLING_WEBHOOK_MAX_BODY_BYTES + 1)),
    );
    expect(res.status).toBe(413);
    expect(parseWebhook).not.toHaveBeenCalled();
  });

  it("acknowledges events it does not act on", async () => {
    const { app, sync } = mount(() => "ignored");
    const res = await app.request(BILLING_WEBHOOK_PATH, post("{}"));
    expect(res.status).toBe(200);
    expect(sync).not.toHaveBeenCalled();
  });

  it("syncs the customer named by a verified event", async () => {
    const parseWebhook = vi.fn(() => ({ customerId: "cus_1" }));
    const { app, sync } = mount(parseWebhook);
    const res = await app.request(BILLING_WEBHOOK_PATH, post('{"id":"evt_1"}'));
    expect(res.status).toBe(200);
    expect(parseWebhook).toHaveBeenCalledWith('{"id":"evt_1"}', expect.any(Headers));
    expect(sync).toHaveBeenCalledWith("cus_1");
  });

  it("fails the delivery so the provider retries when sync fails", async () => {
    const { app } = mount(() => ({ customerId: "cus_1" }), {
      sync: async () => {
        throw new Error("provider unavailable");
      },
    });
    const res = await app.request(BILLING_WEBHOOK_PATH, post("{}"));
    expect(res.status).toBe(500);
  });
});

describe("billing checkout return", () => {
  it("syncs the signed-in user's organization and returns to the app", async () => {
    const { app, syncForActor } = mount(() => null);
    const res = await app.request(BILLING_RETURN_PATH);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://app.example.com/app");
    expect(syncForActor).toHaveBeenCalledWith(actor);
  });

  it("hands a mobile checkout back to the app without a session", async () => {
    const { app, syncForActor } = mount(() => null, { actor: null });
    const res = await app.request(`${BILLING_RETURN_PATH}?client=mobile`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("rakazo://billing");
    expect(syncForActor).not.toHaveBeenCalled();
  });

  it("sends a signed-out visitor to the web origin", async () => {
    const { app, syncForActor } = mount(() => null, { actor: null });
    const res = await app.request(BILLING_RETURN_PATH);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://app.example.com");
    expect(syncForActor).not.toHaveBeenCalled();
  });
});
