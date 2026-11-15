import { createPrivateKey, sign } from "node:crypto";
import { connect } from "node:http2";
import type { IncomingCallNotification as IncomingCallPush } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";

export type { IncomingCallNotification as IncomingCallPush } from "@rakazo/adapter-kit";

export interface VoipPushProvider {
  send(token: string, call: IncomingCallPush): Promise<"sent" | "invalid" | "unavailable">;
}

export type ApnsVoipConfig = {
  keyId: string;
  teamId: string;
  privateKey: string;
  environment: "sandbox" | "production";
  bundleId: string;
};

export type ApnsTransport = (
  origin: string,
  headers: Record<string, string>,
  body: string,
) => Promise<{ status: number; reason?: string }>;

/** HTTP/2 stays in this adapter; tests inject a transport and never contact Apple. */
const apnsTransport: ApnsTransport = (origin, headers, body) =>
  new Promise((resolve, reject) => {
    const client = connect(origin);
    const finish = () => client.close();
    client.setTimeout(10_000, () => client.destroy(new Error("APNs connection timed out")));
    client.on("error", () => {
      finish();
      reject(new Error("APNs connection failed"));
    });
    const request = client.request(headers);
    let status = 0;
    let data = "";
    request.setTimeout(10_000, () => request.destroy(new Error("APNs request timed out")));
    request.on("response", (reply) => {
      status = Number(reply[":status"]);
    });
    request.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > 4096) request.destroy(new Error("APNs response too large"));
    });
    request.on("error", () => {
      finish();
      reject(new Error("APNs request failed"));
    });
    request.on("end", () => {
      finish();
      let reason: string | undefined;
      try {
        reason = (JSON.parse(data) as { reason?: string }).reason;
      } catch {
        /* Empty success response. */
      }
      resolve({ status, reason });
    });
    request.end(body);
  });

/** Signs and sends one APNs request; each push type adds its own topic and payload. */
export class ApnsClient {
  private readonly key;
  private jwt?: { value: string; issuedAt: number };
  constructor(
    readonly config: ApnsVoipConfig,
    private readonly transport: ApnsTransport = apnsTransport,
  ) {
    this.key = createPrivateKey(config.privateKey);
  }
  private authorization(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.jwt && now >= this.jwt.issuedAt && now - this.jwt.issuedAt < 50 * 60)
      return this.jwt.value;
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: this.config.keyId })).toString(
      "base64url",
    );
    const claims = Buffer.from(JSON.stringify({ iss: this.config.teamId, iat: now })).toString(
      "base64url",
    );
    const unsigned = `${header}.${claims}`;
    const signature = sign("sha256", Buffer.from(unsigned), {
      key: this.key,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    const value = `bearer ${unsigned}.${signature}`;
    this.jwt = { value, issuedAt: now };
    return value;
  }
  /** Sends one push. Failures are logged under `failureEvent` and never thrown. */
  async send(
    token: string,
    request: {
      topic: string;
      pushType: string;
      priority: 5 | 10;
      expiration: number;
      body: unknown;
    },
    failureEvent: string,
  ): Promise<"sent" | "invalid" | "unavailable"> {
    try {
      const reply = await this.transport(
        this.config.environment === "sandbox"
          ? "https://api.sandbox.push.apple.com"
          : "https://api.push.apple.com",
        {
          ":method": "POST",
          ":path": `/3/device/${token}`,
          authorization: this.authorization(),
          "apns-topic": request.topic,
          "apns-push-type": request.pushType,
          "apns-priority": String(request.priority),
          "apns-expiration": String(request.expiration),
          "content-type": "application/json",
        },
        JSON.stringify(request.body),
      );
      if (reply.status === 410 || reply.reason === "Unregistered") return "invalid";
      if (reply.status === 200) return "sent";
      // BadDeviceToken also means a sandbox/production mismatch, so it never drops the token.
      getLogger().warn(failureEvent, { status: reply.status, reason: reply.reason });
      return "unavailable";
    } catch (error) {
      getLogger().warn(failureEvent, { error });
      return "unavailable";
    }
  }
}

export class ApnsVoipProvider implements VoipPushProvider {
  private readonly client: ApnsClient;
  constructor(config: ApnsVoipConfig, transport?: ApnsTransport) {
    this.client = new ApnsClient(config, transport);
  }
  async send(token: string, call: IncomingCallPush): Promise<"sent" | "invalid" | "unavailable"> {
    const expiration = Math.floor(Date.parse(call.expiresAt) / 1000);
    if (!(expiration > Date.now() / 1000)) return "unavailable";
    return this.client.send(
      token,
      {
        topic: `${this.client.config.bundleId}.voip`,
        pushType: "voip",
        priority: 10,
        expiration,
        body: {
          aps: {},
          callId: call.callId,
          botId: call.botId,
          botName: call.botName.slice(0, 100),
          expiresAt: call.expiresAt,
        },
      },
      "call.voip_push_failed",
    );
  }
}
