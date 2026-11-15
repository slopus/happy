import { createHmac } from "node:crypto";

export type GithubWebhookDeliveryInput = {
  botId: string;
  event: string;
  deliveryId?: string;
  payload?: unknown;
  secret?: string;
  origin?: string;
};

/**
 * Deterministic GitHub webhook boundary emulator: mints HMAC-signed delivery
 * requests for bot GitHub trigger routes without talking to GitHub.
 */
export class GithubWebhookEmulator {
  readonly signingSecret = "github-webhook-test-secret-32chars!";
  private deliveryCounter = 0;

  nextDeliveryId(): string {
    this.deliveryCounter += 1;
    return `00000000-0000-4000-8000-${String(this.deliveryCounter).padStart(12, "0")}`;
  }

  sign(raw: string, secret = this.signingSecret): string {
    return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  }

  /** A webhook request exactly as GitHub would deliver it (HMAC over the raw body). */
  buildDeliveryRequest(input: GithubWebhookDeliveryInput): Request {
    const raw =
      typeof input.payload === "string"
        ? input.payload
        : JSON.stringify(input.payload ?? { zen: "emulated", hook_id: 1 });
    const origin = input.origin ?? "https://rakazo.test";
    const secret = input.secret ?? this.signingSecret;
    return new Request(`${origin}/api/v1/bots/${input.botId}/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": input.event,
        "x-github-delivery": input.deliveryId ?? this.nextDeliveryId(),
        "x-hub-signature-256": this.sign(raw, secret),
        "user-agent": "GitHub-Hookshot/emulator",
      },
      body: raw,
    });
  }
}
