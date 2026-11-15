import { createHmac, timingSafeEqual } from "node:crypto";
import type { MessagingInstallProvider } from "@rakazo/adapter-kit";
import { readBoundedJsonResponse } from "@rakazo/core";
import {
  ChatSdkMessagingSurface,
  MESSAGING_WEBHOOK_MAX_BODY_BYTES,
  readBoundedText,
} from "./chat-sdk-surface.js";
import { messagingPlatformsFromEnv } from "./messaging-platforms.js";

const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;

const SCOPES = [
  "app_mentions:read",
  "chat:write",
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:read",
  "im:write",
  "im:history",
  "mpim:read",
  "mpim:history",
  "users:read",
  "reactions:write",
  "files:read",
  "files:write",
];

export class SlackInstallProvider implements MessagingInstallProvider {
  readonly provider = "slack";
  readonly capabilities = { direct: true, groups: true, receipt: "reaction" as const };
  constructor(
    private readonly config: {
      clientId: string;
      clientSecret: string;
      signingSecret: string;
      redirectUri: string;
    },
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  authorizeUrl(state: string): string {
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      scope: SCOPES.join(","),
      redirect_uri: this.config.redirectUri,
      state,
    }).toString();
    return url.toString();
  }

  async exchange(code: string) {
    const response = await this.fetcher("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.redirectUri,
        code,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const result = await readBoundedJsonResponse<{
      ok?: boolean;
      access_token?: string;
      team?: { id?: string; name?: string };
      authed_user?: { id?: string };
      is_enterprise_install?: boolean;
      refresh_token?: string;
    }>(response, MAX_OAUTH_RESPONSE_BYTES).catch(() => undefined);
    // Org-wide installs and rotating tokens need distinct lifecycle support.
    if (
      !response.ok ||
      !result?.ok ||
      !result.access_token ||
      !result.team?.id ||
      result.is_enterprise_install ||
      result.refresh_token
    )
      throw new Error("Slack workspace authorization failed");
    return {
      workspaceId: result.team.id,
      workspaceName: result.team.name ?? "Slack",
      credential: result.access_token,
      ...(result.authed_user?.id ? { ownerId: result.authed_user.id } : {}),
    };
  }

  surface(credential: string) {
    return new ChatSdkMessagingSurface(
      messagingPlatformsFromEnv({
        slackBotToken: credential,
        slackSigningSecret: this.config.signingSecret,
      }),
    );
  }

  async parseWebhook(request: Request) {
    const body = await readBoundedText(request, MESSAGING_WEBHOOK_MAX_BODY_BYTES);
    if (body === null) throw new Error("Invalid webhook");
    const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
    const signature = request.headers.get("x-slack-signature") ?? "";
    if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300)
      throw new Error("Invalid webhook");
    const expected = `v0=${createHmac("sha256", this.config.signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      throw new Error("Invalid webhook");
    const payload = JSON.parse(body) as {
      type?: string;
      challenge?: string;
      team_id?: string;
      event?: { type?: string };
    };
    return {
      request: new Request(request.url, { method: request.method, headers: request.headers, body }),
      workspaceId: payload.team_id,
      challenge: payload.type === "url_verification" ? payload.challenge : undefined,
      uninstalled: payload.event?.type === "app_uninstalled",
    };
  }
}
