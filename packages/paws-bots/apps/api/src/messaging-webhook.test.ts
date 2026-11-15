import type { MessagingSurface } from "@rakazo/adapter-kit";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { MESSAGING_WEBHOOK_BASE_PATH, mountMessagingWebhookRoutes } from "./messaging-webhook.js";

// Verification and parsing live in the platform adapters; these tests pin routing only.
function mount(respond?: (provider: string, request: Request) => Response) {
  const handleWebhook = vi.fn((provider: string, request: Request) => {
    if (provider !== "sendblue" && provider !== "whatsapp") return null;
    return Promise.resolve(respond?.(provider, request) ?? Response.json({ ok: true }));
  });
  const app = new Hono();
  mountMessagingWebhookRoutes(app, {
    messaging: { handleWebhook } as unknown as MessagingSurface,
  });
  return { app, handleWebhook };
}

function post(body: string) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  };
}

const payload = JSON.stringify({ content: "hi", is_outbound: false });

describe("messaging webhook HTTP routes", () => {
  it("forwards the raw request to the surface under the :provider param", async () => {
    const { app, handleWebhook } = mount();
    const res = await app.request(`${MESSAGING_WEBHOOK_BASE_PATH}/sendblue`, post(payload));

    expect(res.status).toBe(200);
    expect(handleWebhook).toHaveBeenCalledTimes(1);
    const [provider, request] = handleWebhook.mock.calls[0]! as [string, Request];
    expect(provider).toBe("sendblue");
    // The raw Request passes through untouched so platform adapters can
    // verify signatures against the exact body bytes and headers.
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe(`${MESSAGING_WEBHOOK_BASE_PATH}/sendblue`);
    await expect(request.text()).resolves.toBe(payload);
  });

  it("returns 404 for a provider the surface does not host", async () => {
    const { app, handleWebhook } = mount();
    const res = await app.request(`${MESSAGING_WEBHOOK_BASE_PATH}/carrier-pigeon`, post(payload));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Unknown provider" });
    expect(handleWebhook).toHaveBeenCalledWith("carrier-pigeon", expect.any(Request));
  });

  it("keeps the legacy phone webhook path routing to sendblue", async () => {
    const { app, handleWebhook } = mount();
    const res = await app.request("/api/v1/phone/webhook", post(payload));

    expect(res.status).toBe(200);
    expect(handleWebhook).toHaveBeenCalledWith("sendblue", expect.any(Request));
    const [, request] = handleWebhook.mock.calls[0]! as [string, Request];
    await expect(request.text()).resolves.toBe(payload);
  });

  it("returns the surface's response verbatim, including rejections", async () => {
    const { app } = mount(() => new Response("signature mismatch", { status: 401 }));
    const res = await app.request(`${MESSAGING_WEBHOOK_BASE_PATH}/sendblue`, post(payload));

    expect(res.status).toBe(401);
    await expect(res.text()).resolves.toBe("signature mismatch");
  });

  it("passes GET requests through for provider challenges", async () => {
    // WhatsApp verifies its webhook with a GET hub.challenge handshake.
    const { app, handleWebhook } = mount((_provider, request) => {
      const challenge = new URL(request.url).searchParams.get("hub.challenge");
      return new Response(challenge ?? "", { status: 200 });
    });
    const res = await app.request(
      `${MESSAGING_WEBHOOK_BASE_PATH}/whatsapp?hub.mode=subscribe&hub.challenge=12345`,
      { method: "GET" },
    );

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("12345");
    const [provider, request] = handleWebhook.mock.calls[0]! as [string, Request];
    expect(provider).toBe("whatsapp");
    expect(request.method).toBe("GET");
  });
});
