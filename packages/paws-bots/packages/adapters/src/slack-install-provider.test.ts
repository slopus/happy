import { createHmac } from "node:crypto";
import { expect, it, vi } from "vitest";
import { SlackInstallProvider } from "./slack-install-provider.js";

const config = {
  clientId: "client",
  clientSecret: "client-secret",
  signingSecret: "signing-secret",
  redirectUri: "https://app.example.test/callback",
};
function signed(body: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  return new Request("https://app.example.test/webhook", {
    method: "POST",
    body,
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${createHmac("sha256", config.signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`,
    },
  });
}
it("builds a workspace OAuth request with state and the configured callback", () => {
  const url = new URL(new SlackInstallProvider(config).authorizeUrl("nonce"));
  expect(url.origin).toBe("https://slack.com");
  expect(url.searchParams.get("state")).toBe("nonce");
  expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
  expect(url.searchParams.get("scope")).toContain("reactions:write");
  expect(url.searchParams.get("scope")).toContain("files:write");
});
it("verifies Slack signatures, body and replay window before exposing routing metadata", async () => {
  const provider = new SlackInstallProvider(config);
  const body = JSON.stringify({ team_id: "T1", event: { type: "app_uninstalled" } });
  expect(await provider.parseWebhook(signed(body))).toMatchObject({
    workspaceId: "T1",
    uninstalled: true,
  });
  const forged = signed(body);
  forged.headers.set("x-slack-signature", "v0=invalid");
  await expect(provider.parseWebhook(forged)).rejects.toThrow("Invalid webhook");
  await expect(provider.parseWebhook(signed(body, "1"))).rejects.toThrow("Invalid webhook");
});
it("rejects oversized streaming bodies without trusting Content-Length", async () => {
  await expect(
    new SlackInstallProvider(config).parseWebhook(signed("x".repeat(256 * 1024 + 1))),
  ).rejects.toThrow("Invalid webhook");
});
it("exchanges the authorization code without exposing provider errors or secrets", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ ok: true, access_token: "fake-token", team: { id: "T1", name: "Workspace" } }),
  );
  const provider = new SlackInstallProvider(config, fetcher);
  expect(await provider.exchange("code")).toEqual({
    workspaceId: "T1",
    workspaceName: "Workspace",
    credential: "fake-token",
  });
  expect(fetcher).toHaveBeenCalledWith(
    "https://slack.com/api/oauth.v2.access",
    expect.objectContaining({ method: "POST" }),
  );
  fetcher.mockResolvedValue(Response.json({ ok: false, error: "private-provider-error" }));
  await expect(provider.exchange("code")).rejects.toThrow(/^Slack workspace authorization failed$/);
});
it("refuses an oversized authorization response without reading it", async () => {
  const response = Response.json(
    { ok: true, access_token: "fake-token", team: { id: "T1" } },
    { headers: { "content-length": String(1024 * 1024 * 1024) } },
  );
  const cancel = vi.spyOn(response.body!, "cancel");
  await expect(
    new SlackInstallProvider(config, async () => response).exchange("code"),
  ).rejects.toThrow(/^Slack workspace authorization failed$/);
  expect(cancel).toHaveBeenCalledOnce();
});
it.each([{ is_enterprise_install: true }, { refresh_token: "rotating-token" }])(
  "rejects unsupported installation lifecycles explicitly",
  async (extra) => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true, access_token: "token", team: { id: "T1" }, ...extra }),
    );
    await expect(new SlackInstallProvider(config, fetcher).exchange("code")).rejects.toThrow(
      "authorization failed",
    );
  },
);
