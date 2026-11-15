import * as timers from "node:timers/promises";
import { EmailRecipientRejectedError } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { ResendEmailProvider } from "./resend-email.js";

vi.mock("node:timers/promises", { spy: true });

const config = { apiKey: "fake-api-key", from: "Rakazo <hello@example.test>" };
const message = { to: "user@example.test", subject: "Reset password", text: "Reset link" };

function provider(request: typeof fetch, timeoutMs = 1_000) {
  return new ResendEmailProvider(config, { fetch: request, retryDelaysMs: [0, 0], timeoutMs });
}

describe("ResendEmailProvider", () => {
  it("retries lost responses, throttling and server failures with the same opaque key", async () => {
    for (const failure of [new Error("socket lost"), 429, 500]) {
      const request = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(async () => {
          if (failure instanceof Error) throw failure;
          return new Response("untrusted provider body", { status: failure });
        })
        .mockResolvedValueOnce(Response.json({ id: "email-1" }));
      await provider(request).send(message);
      expect(request).toHaveBeenCalledTimes(2);
      const first = request.mock.calls[0]!;
      const second = request.mock.calls[1]!;
      expect(first[0]).toBe("https://api.resend.com/emails");
      expect(first[1]).toMatchObject({ method: "POST", redirect: "error" });
      expect(first[1]!.headers).toEqual(second[1]!.headers);
      expect(first[1]!.headers).toMatchObject({ authorization: "Bearer fake-api-key" });
      expect(JSON.parse(first[1]!.body as string)).toEqual({ from: config.from, ...message });
    }
  });

  it.each([
    [429, "2", 2_000],
    [503, "2", 2_000],
    [429, "Thu, 22 Oct 2026 10:00:02 GMT", 2_000],
    [429, null, 250],
    [429, "invalid", 250],
  ])("honors retry timing for HTTP %s and header %s", async (status, header, delay) => {
    const sleep = vi.spyOn(timers, "setTimeout").mockResolvedValue(undefined);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-22T10:00:00Z"));
    try {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json(
            {},
            {
              status,
              headers: header === null ? {} : { "retry-after": header },
            },
          ),
        )
        .mockResolvedValueOnce(Response.json({ id: "email-1" }));
      await new ResendEmailProvider(config, { fetch: request }).send(message);
      expect(sleep).toHaveBeenCalledWith(delay, undefined, { signal: expect.any(AbortSignal) });
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[0]![1]!.headers).toEqual(request.mock.calls[1]![1]!.headers);
      expect(request.mock.calls[0]![1]!.signal).toBe(request.mock.calls[1]![1]!.signal);
    } finally {
      sleep.mockRestore();
      now.mockRestore();
    }
  });

  it("keeps the delivery deadline while waiting for Retry-After", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({}, { status: 429, headers: { "retry-after": "2" } }),
      );
    await expect(provider(request, 20).send(message)).rejects.toThrow("timed out");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not let Retry-After add attempts", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({}, { status: 429, headers: { "retry-after": "0" } }),
      );
    const email = new ResendEmailProvider(config, { fetch: request, retryDelaysMs: [] });
    await expect(email.send(message)).rejects.toThrow("HTTP 429");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("sends the configured reply-to address", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "email-1" }));
    await new ResendEmailProvider(
      { ...config, replyTo: "founder@example.test" },
      { fetch: request },
    ).send(message);
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toMatchObject({
      reply_to: "founder@example.test",
    });
  });

  it("sends as a bot's own address, with its copies and reply-to", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "email-1" }));
    await new ResendEmailProvider(
      { ...config, replyTo: "founder@example.test" },
      { fetch: request },
    ).send({
      ...message,
      from: "Scout <scout@bots.test>",
      cc: ["grace@example.test"],
      replyTo: "scout@bots.test",
    });
    const body = JSON.parse(request.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({
      from: "Scout <scout@bots.test>",
      cc: ["grace@example.test"],
      reply_to: "scout@bots.test",
    });
    expect(body).not.toHaveProperty("replyTo");
  });

  it("gives separate deliveries different keys", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ id: "email-1" }));
    const email = provider(request);
    await email.send(message);
    await email.send(message);
    const headers = request.mock.calls.map(([, init]) => new Headers(init!.headers));
    expect(headers[0]!.get("idempotency-key")).not.toBe(headers[1]!.get("idempotency-key"));
  });

  it.each([400, 401, 403, 409, 422])(
    "does not retry HTTP %s or expose the response body",
    async (status) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("private recipient and secret", { status }));
      await expect(provider(request).send(message)).rejects.toThrow(
        `Resend email request failed (HTTP ${status})`,
      );
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("names Resend's validation error without the recipient", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          statusCode: 422,
          name: "validation_error",
          message: "Invalid `to` field: user@example.test",
        },
        { status: 422 },
      ),
    );
    const delivery = provider(request).send(message);
    await expect(delivery).rejects.toThrow(
      /^Resend email request failed \(HTTP 422: validation_error: Invalid `to` field: <address>\)$/,
    );
    await expect(delivery).rejects.toBeInstanceOf(EmailRecipientRejectedError);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not treat other validation errors as a refused recipient", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { statusCode: 422, name: "validation_error", message: "Invalid `from` field." },
          { status: 422 },
        ),
      );
    const delivery = provider(request).send(message);
    await expect(delivery).rejects.toThrow(/HTTP 422/);
    await expect(delivery).rejects.not.toBeInstanceOf(EmailRecipientRejectedError);
  });

  it("does not read an oversized error body", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ name: "validation_error", message: "x".repeat(10_000) }, { status: 422 }),
      );
    await expect(provider(request).send(message)).rejects.toThrow(
      /^Resend email request failed \(HTTP 422\)$/,
    );
  });

  it("bounds retries and strips network errors", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("private credentials"));
    await expect(provider(request).send(message)).rejects.toThrow(/^Resend email request failed$/);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("requires a valid success response", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ error: "private" }));
    await expect(provider(request).send(message)).rejects.toThrow("invalid email response");
  });

  it("does not read an oversized success body", async () => {
    const response = () =>
      Response.json({ id: "email_1" }, { headers: { "content-length": String(1024 * 1024) } });
    const responses = [response(), response(), response()];
    const request = vi.fn<typeof fetch>();
    for (const sent of responses) request.mockResolvedValueOnce(sent);
    const cancels = responses.map((sent) => vi.spyOn(sent.body!, "cancel"));
    await expect(provider(request).send(message)).rejects.toThrow(/^Resend email request failed$/);
    for (const cancel of cancels) expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds a stalled response body and drains without accepting new sends", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = new ReadableStream({
        start(controller) {
          init!.signal!.addEventListener("abort", () => controller.error(new Error("aborted")), {
            once: true,
          });
        },
      });
      return new Response(body);
    });
    const email = provider(request, 20);
    const delivery = expect(email.send(message)).rejects.toThrow("timed out");
    await email.drain();
    await delivery;
    await expect(email.send(message)).rejects.toThrow("shutting down");
  });

  it("waits for accepted delivery on shutdown", async () => {
    let complete!: (response: Response) => void;
    const email = provider(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const delivery = email.send(message);
    const drained = vi.fn();
    const draining = email.drain().then(drained);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    complete(Response.json({ id: "email-1" }));
    await delivery;
    await draining;
    expect(drained).toHaveBeenCalledOnce();
  });

  it("fails early on incomplete configuration", () => {
    expect(() => new ResendEmailProvider({ ...config, apiKey: " " })).toThrow("EMAIL_API_KEY");
    expect(() => new ResendEmailProvider({ ...config, from: " " })).toThrow("EMAIL_FROM");
  });
});
