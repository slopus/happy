import { BotSecretPutInput } from "@rakazo/contracts";
import type * as Db from "@rakazo/db";
import { recordSecurityEvent } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthResponseAudit, procedureSecurityEvent } from "./security-audit.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  recordSecurityEvent: vi.fn(async () => undefined),
}));

const actor = { userId: "user-1", spaceId: "space-1" };

beforeEach(() => vi.mocked(recordSecurityEvent).mockClear());

describe("procedureSecurityEvent", () => {
  it("records which credential changed without its value", () => {
    const event = procedureSecurityEvent(
      ["models", "connect"],
      { provider: "openrouter", apiKey: "sk-or-v1-secretvalue", label: "Work key" },
      actor,
    );
    expect(event).toEqual({
      type: "credential.created",
      userId: "user-1",
      spaceId: "space-1",
      metadata: { procedure: "models.connect", kind: "model", provider: "openrouter" },
    });
  });

  it("keeps secret names but never secret values", () => {
    const event = procedureSecurityEvent(
      ["botSecrets", "put"],
      // The real RPC shape, so a renamed field fails here instead of silently dropping the name.
      BotSecretPutInput.parse({
        botId: "bot-1",
        destination: { name: "github-deploy", auth: { type: "command" } },
        value: "ghp_secretvalue",
      }),
      actor,
    );
    expect(event?.metadata).toEqual({
      procedure: "botSecrets.put",
      kind: "bot_secret",
      botId: "bot-1",
      name: "github-deploy",
    });
    expect(JSON.stringify(event)).not.toContain("ghp_secretvalue");
  });

  it("lists which deployment settings changed without the allowlist itself", () => {
    const event = procedureSecurityEvent(
      ["deployment", "update"],
      { signupsEnabled: true, signupAllowlist: ["owner@example.test"], computerHost: undefined },
      actor,
    );
    expect(event?.type).toBe("deployment.settings.changed");
    expect(event?.metadata).toMatchObject({
      changed: "signupAllowlist,signupsEnabled",
      signupsEnabled: true,
    });
    expect(JSON.stringify(event)).not.toContain("owner@example.test");
  });

  it("records an MCP approval as a decision", () => {
    expect(
      procedureSecurityEvent(
        ["mcp", "assignments", "dismiss"],
        { botId: "bot-1", serverId: "server-1" },
        actor,
      ),
    ).toMatchObject({ type: "approval.decided", metadata: { decision: "deny", kind: "mcp" } });
  });

  it("ignores procedures that change nothing security-relevant", () => {
    expect(procedureSecurityEvent(["threads", "send"], { text: "hello" }, actor)).toBeUndefined();
  });
});

describe("createAuthResponseAudit", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("records a failed sign-in with its error code and no credentials", async () => {
    const audit = createAuthResponseAudit();
    await audit(
      "/sign-in/email",
      "203.0.113.5",
      json(401, { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }),
    );
    expect(recordSecurityEvent).toHaveBeenCalledWith({
      type: "auth.sign_in.failed",
      ip: "203.0.113.5",
      metadata: { path: "/sign-in/email", status: 401, reason: "INVALID_EMAIL_OR_PASSWORD" },
    });
  });

  it("records a refused sign-up", async () => {
    const audit = createAuthResponseAudit();
    await audit("/sign-up/email", "203.0.113.5", json(400, { code: "REGISTRATION_CLOSED" }));
    expect(recordSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "auth.sign_up.failed" }),
    );
  });

  it("does not record successes or unrelated failures here", async () => {
    const audit = createAuthResponseAudit();
    await audit("/sign-in/email", "203.0.113.5", json(200, { token: "session-token" }));
    await audit("/get-session", "203.0.113.5", json(401, {}));
    expect(recordSecurityEvent).not.toHaveBeenCalled();
  });

  it("records a rate-limit hit once a minute per address and path", async () => {
    let now = 0;
    const audit = createAuthResponseAudit(() => now);
    for (let attempt = 0; attempt < 20; attempt++) {
      await audit("/sign-in/email", "203.0.113.5", new Response(null, { status: 429 }));
    }
    await audit("/sign-in/email", "198.51.100.7", new Response(null, { status: 429 }));
    expect(recordSecurityEvent).toHaveBeenCalledTimes(2);
    now = 61_000;
    await audit("/sign-in/email", "203.0.113.5", new Response(null, { status: 429 }));
    expect(recordSecurityEvent).toHaveBeenCalledTimes(3);
    expect(recordSecurityEvent).toHaveBeenLastCalledWith({
      type: "rate_limit.hit",
      ip: "203.0.113.5",
      metadata: { path: "/sign-in/email" },
    });
  });
});
