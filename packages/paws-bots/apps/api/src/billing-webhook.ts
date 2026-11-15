import type { BillingProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { MOBILE_BILLING_CALLBACK_URL } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";
import type { BillingService } from "./billing.js";
import { BILLING_RETURN_PATH } from "./billing.js";
import { readBoundedBody } from "./http-body.js";

export const BILLING_WEBHOOK_PATH = "/api/v1/billing/webhook";
export const BILLING_WEBHOOK_MAX_BODY_BYTES = 512 * 1024;

export function mountBillingRoutes(
  app: Hono,
  deps: {
    billing: BillingService;
    provider: Pick<BillingProvider, "parseWebhook">;
    webOrigin: string;
    authenticate: (request: Request) => Promise<Actor | null>;
  },
): void {
  // The payload only names the customer; sync re-reads the subscription from the provider.
  app.post(BILLING_WEBHOOK_PATH, async (c) => {
    const raw = await readBoundedBody(c.req.raw, BILLING_WEBHOOK_MAX_BODY_BYTES);
    if (raw === null) return c.json({ error: "Payload too large" }, 413);
    const parsed = deps.provider.parseWebhook(raw, c.req.raw.headers);
    if (parsed === null) return c.json({ error: "Invalid signature" }, 400);
    if (parsed === "ignored") return c.json({ ok: true });
    try {
      await deps.billing.sync(parsed.customerId);
    } catch (error) {
      // A non-2xx makes the provider retry the delivery.
      getLogger().error("billing webhook sync failed", error);
      return c.json({ error: "Sync failed" }, 500);
    }
    return c.json({ ok: true });
  });

  app.get(BILLING_RETURN_PATH, async (c) => {
    // The in-app browser has no session; the app refreshes billing once it is back.
    if (c.req.query("client") === "mobile") return c.redirect(MOBILE_BILLING_CALLBACK_URL, 303);
    const actor = await deps.authenticate(c.req.raw);
    if (!actor) return c.redirect(deps.webOrigin, 303);
    try {
      await deps.billing.syncForActor(actor);
    } catch (error) {
      // The webhook still delivers the change; the app shows the paywall until it lands.
      getLogger().error("billing return sync failed", error);
    }
    return c.redirect(`${deps.webOrigin}/app`, 303);
  });
}
