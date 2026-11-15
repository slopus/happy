import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { TransactionalEmail, TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { EmailRecipientRejectedError } from "@rakazo/adapter-kit";
import { cancelResponseBody, parseRetryAfter, readBoundedJsonResponse } from "@rakazo/core";

const MAX_RESPONSE_BYTES = 4_096;

interface ResendEmailConfig {
  apiKey: string;
  from: string;
  replyTo?: string;
}

interface ResendEmailDependencies {
  fetch?: typeof fetch;
  retryDelaysMs?: readonly number[];
  timeoutMs?: number;
}

/** Product code supplies rendered content; only this adapter knows Resend's API. */
export class ResendEmailProvider implements TransactionalEmailProvider {
  private readonly request: typeof fetch;
  private readonly retryDelaysMs: readonly number[];
  private readonly timeoutMs: number;
  private readonly inFlight = new Set<Promise<void>>();
  private accepting = true;

  constructor(
    private readonly config: ResendEmailConfig,
    dependencies: ResendEmailDependencies = {},
  ) {
    if (!config.apiKey.trim()) throw new Error("EMAIL_API_KEY is required for Resend");
    if (!config.from.trim()) throw new Error("EMAIL_FROM is required for Resend");
    this.request = dependencies.fetch ?? fetch;
    this.retryDelaysMs = dependencies.retryDelaysMs ?? [250, 1_000];
    this.timeoutMs = dependencies.timeoutMs ?? 10_000;
  }

  describe() {
    return {
      id: "resend",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { transactional: true },
    };
  }

  send(message: TransactionalEmail): Promise<void> {
    if (!this.accepting) return Promise.reject(new Error("Email provider is shutting down"));
    const delivery = this.deliver(message);
    this.inFlight.add(delivery);
    void delivery.then(
      () => this.inFlight.delete(delivery),
      () => this.inFlight.delete(delivery),
    );
    return delivery;
  }

  async drain(): Promise<void> {
    this.accepting = false;
    // Each delivery has one deadline covering requests, response bodies and retry waits.
    await Promise.allSettled([...this.inFlight]);
  }

  private async deliver(message: TransactionalEmail): Promise<void> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    // Reuse only within this delivery: a later sign-in request must get a new email.
    const idempotencyKey = randomUUID();
    const { from, replyTo, cc, ...rest } = message;
    const reply = replyTo ?? this.config.replyTo;
    const body = JSON.stringify({
      from: from ?? this.config.from,
      ...(reply ? { reply_to: reply } : {}),
      ...(cc?.length ? { cc } : {}),
      ...rest,
    });
    for (let attempt = 0; ; attempt++) {
      let retry = true;
      let retryAfterMs: number | undefined;
      let recipientRejected = false;
      let failure = "Resend email request failed";
      try {
        const response = await this.request("https://api.resend.com/emails", {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body,
          signal,
        });
        if (response.ok) {
          const result: unknown = await readBoundedJsonResponse(response, MAX_RESPONSE_BYTES);
          if (
            typeof result === "object" &&
            result !== null &&
            "id" in result &&
            typeof result.id === "string" &&
            result.id.length > 0
          )
            return;
          failure = "Resend returned an invalid email response";
        } else {
          retry = response.status === 429 || response.status >= 500;
          retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
          const error = await errorDetail(response);
          recipientRejected = error.recipientRejected;
          failure = `Resend email request failed (HTTP ${response.status}${error.detail})`;
        }
      } catch {
        // A lost response may already have sent the email; the same key makes retry safe.
      }
      if (signal.aborted) throw new Error("Resend email delivery timed out");
      const delay = this.retryDelaysMs[attempt];
      if (recipientRejected) throw new EmailRecipientRejectedError(failure);
      if (!retry || delay === undefined) throw new Error(failure);
      try {
        await sleep(retryAfterMs ?? delay, undefined, { signal });
      } catch {
        throw new Error("Resend email delivery timed out");
      }
    }
  }
}

/**
 * Resend's error name and message, without addresses: the message can quote a recipient.
 * A validation error naming a recipient field means the address itself was refused.
 */
async function errorDetail(
  response: Response,
): Promise<{ detail: string; recipientRejected: boolean }> {
  const body: unknown = await readBoundedJsonResponse(response, MAX_RESPONSE_BYTES).catch(() => {
    cancelResponseBody(response);
    return undefined;
  });
  if (typeof body !== "object" || body === null) return { detail: "", recipientRejected: false };
  const { name, message } = body as { name?: unknown; message?: unknown };
  const errorName = typeof name === "string" && /^[a-z_]{1,64}$/.test(name) ? name : "";
  const text =
    typeof message === "string" ? message.replace(/\S+@\S+/g, "<address>").slice(0, 200) : "";
  const parts = [errorName, text].filter(Boolean);
  return {
    detail: parts.length > 0 ? `: ${parts.join(": ")}` : "",
    recipientRejected:
      response.status < 500 && errorName === "validation_error" && /`(to|cc)`/.test(text),
  };
}
