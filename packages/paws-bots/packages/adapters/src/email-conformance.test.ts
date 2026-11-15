import type { TransactionalEmail, TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { EmailEmulator } from "./email-emulator.js";
import { ResendEmailProvider } from "./resend-email.js";
import { SmtpEmailProvider } from "./smtp-email.js";

const factories: Record<
  string,
  (capture: (message: TransactionalEmail) => void) => TransactionalEmailProvider
> = {
  emulator: (capture) => new EmailEmulator(capture),
  smtp: (capture) =>
    new SmtpEmailProvider(
      { url: "smtps://smtp.example.test", from: "hello@example.test" },
      {
        transport: {
          sendMail: async (message: TransactionalEmail) => {
            capture(message);
          },
        } as never,
      },
    ),
  resend: (capture) =>
    new ResendEmailProvider(
      { apiKey: "fake-api-key", from: "hello@example.test" },
      {
        fetch: async (_url, init) => {
          capture(JSON.parse(init!.body as string));
          return Response.json({ id: "email-1" });
        },
      },
    ),
};

describe.each(Object.entries(factories))("%s transactional email contract", (_name, create) => {
  it.each([undefined, "<p>Rendered content</p>"])(
    "preserves product content (html: %s)",
    async (html) => {
      const sent: TransactionalEmail[] = [];
      const email = create((message) => sent.push(message));
      const message = {
        to: "user@example.test",
        subject: "Account email",
        text: "Plain content",
        ...(html ? { html } : {}),
      };
      expect(email.describe()).toMatchObject({
        contractVersion: "1",
        capabilities: { transactional: true },
      });
      await email.send(message);
      await email.drain?.();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject(message);
      expect(sent[0]!.html).toBe(html);
    },
  );

  it("passes message headers through", async () => {
    const sent: TransactionalEmail[] = [];
    const email = create((message) => sent.push(message));
    const headers = {
      "List-Unsubscribe": "<https://app.example.test/unsubscribe?token=fake>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
    await email.send({ to: "user@example.test", subject: "Update", text: "Body", headers });
    await email.drain?.();
    expect(sent[0]!.headers).toEqual(headers);
  });
});
