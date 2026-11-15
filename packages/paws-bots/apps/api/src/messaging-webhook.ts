import type { MessagingSurface } from "@rakazo/adapter-kit";
import type { Hono } from "hono";

export const MESSAGING_WEBHOOK_BASE_PATH = "/api/v1/messaging/webhook";

/**
 * Signature verification happens inside the surface's platform adapters; replay safety comes
 * from per-message client nonces downstream.
 */
export function mountMessagingWebhookRoutes(app: Hono, deps: { messaging: MessagingSurface }) {
  app.all(`${MESSAGING_WEBHOOK_BASE_PATH}/:provider`, async (c) => {
    const response = deps.messaging.handleWebhook(c.req.param("provider"), c.req.raw);
    if (!response) return c.json({ error: "Unknown provider" }, 404);
    return response;
  });
  // The pre-multi-platform sendblue path; already-configured dashboards
  // keep delivering without an update.
  app.post("/api/v1/phone/webhook", async (c) => {
    const response = deps.messaging.handleWebhook("sendblue", c.req.raw);
    if (!response) return c.json({ error: "Unknown provider" }, 404);
    return response;
  });
}
