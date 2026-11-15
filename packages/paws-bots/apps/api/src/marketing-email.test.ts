import { EmailEmulator } from "@rakazo/adapters";
import { describe, expect, it, vi } from "vitest";
import { marketingEmailRoutes, sendWelcomeEmail, unsubscribeUrl } from "./marketing-email.js";

const secret = "test-auth-secret-at-least-32-characters";
const origin = "https://app.example.test";

function routes() {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  return { app: marketingEmailRoutes({ user: { updateMany } } as never, secret), updateMany };
}

describe("marketing email unsubscribe", () => {
  it("shows a confirm button on GET without unsubscribing", async () => {
    const { app, updateMany } = routes();
    const response = await app.request(unsubscribeUrl(origin, secret, "user-1"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<form method="post">');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("unsubscribes the signed user on a one-click POST", async () => {
    const { app, updateMany } = routes();
    const response = await app.request(unsubscribeUrl(origin, secret, "user-1"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(response.status).toBe(200);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "user-1", marketingEmailOptOutAt: null },
      data: { marketingEmailOptOutAt: expect.any(Date) },
    });
  });

  it.each([
    ["another user's token", unsubscribeUrl(origin, secret, "user-2").replace("user-2", "user-1")],
    ["a token from another secret", unsubscribeUrl(origin, `${secret}-other`, "user-1")],
    ["no token", `${origin}/api/v1/email/unsubscribe?user=user-1`],
  ])("rejects %s", async (_name, url) => {
    const { app, updateMany } = routes();
    const response = await app.request(url, { method: "POST" });
    expect(response.status).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("sendWelcomeEmail", () => {
  function deps(claimed: boolean) {
    const email = new EmailEmulator();
    const createMany = vi.fn(async () => ({ count: claimed ? 1 : 0 }));
    const onError = vi.fn();
    const prisma = {
      user: { findFirst: async () => ({ email: "new@example.test", name: "New" }) },
      emailSend: { createMany },
    } as never;
    return { email, createMany, onError, deps: { prisma, email, origin, secret, onError } };
  }

  it("claims the welcome once and sends one-click unsubscribe headers matching the body link", async () => {
    const { email, createMany, onError, deps: welcome } = deps(true);
    await sendWelcomeEmail(welcome, "user-1");
    await vi.waitFor(() => expect(email.sent).toHaveLength(1));
    expect(createMany).toHaveBeenCalledWith({
      data: { userId: "user-1", kind: "welcome" },
      skipDuplicates: true,
    });
    const url = unsubscribeUrl(origin, secret, "user-1");
    expect(email.sent[0]).toMatchObject({
      to: "new@example.test",
      subject: "Welcome to Rakazo",
      headers: {
        "List-Unsubscribe": `<${url}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    expect(email.sent[0]!.text).toContain(url);
    expect(onError).not.toHaveBeenCalled();
  });

  it("writes the welcome in the language of the browser that signed up", async () => {
    const { email, deps: welcome } = deps(true);
    await sendWelcomeEmail(welcome, "user-1", new Headers({ "accept-language": "es-CL,es" }));
    await vi.waitFor(() => expect(email.sent).toHaveLength(1));
    expect(email.sent[0]!.subject).toBe("Te damos la bienvenida a Rakazo");
    expect(email.sent[0]!.text).toMatch(/Windows \S+ y Linux/);
  });

  it("sends nothing when another sign-in already claimed the welcome", async () => {
    const { email, deps: welcome } = deps(false);
    await sendWelcomeEmail(welcome, "user-1");
    expect(email.sent).toHaveLength(0);
  });

  it("reports delivery failures without throwing", async () => {
    const { email, onError, deps: welcome } = deps(true);
    email.failNextSends();
    await sendWelcomeEmail(welcome, "user-1");
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  });
});
