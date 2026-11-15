import { LOCAL_COMPUTER_HOST_PATH, LOCAL_SETTINGS_TOKEN_HEADER } from "@rakazo/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountLocalComputerHost, validLocalSettingsToken } from "./local-settings.js";

const token = "ab".repeat(32);
function fixture(sandboxProvider = "docker") {
  const upsert = vi.fn(async () => ({}));
  const app = new Hono();
  mountLocalComputerHost(app, {
    token,
    sandboxProvider,
    prisma: { deploymentSettings: { upsert } } as never,
  });
  const request = (body = "{}", supplied: string | null = token) =>
    app.request(LOCAL_COMPUTER_HOST_PATH, {
      method: "POST",
      headers: {
        ...(supplied === null ? {} : { [LOCAL_SETTINGS_TOKEN_HEADER]: supplied }),
        cookie: "session=fake",
      },
      body,
    });
  return { app, request, upsert };
}

describe("native computer host capability", () => {
  it("refuses session cookies without the private native token", async () => {
    const f = fixture();
    for (const supplied of [null, "", "cd".repeat(32), `${token}x`]) {
      expect((await f.request('{"computerHost":"this-mac"}', supplied)).status).toBe(401);
    }
    expect(f.upsert).not.toHaveBeenCalled();
    expect(validLocalSettingsToken(undefined, token)).toBe(false);
    expect(validLocalSettingsToken(token, token)).toBe(true);
  });
  it("does not grant account settings or server administration even with the native token", async () => {
    const f = fixture();
    for (const procedure of [
      "me",
      "models/list",
      "models/connect",
      "deployment/update",
      "integrationSetup/save",
      "security/events",
      "updater/apply",
    ]) {
      expect(
        (
          await f.app.request(`/api/desktop-settings/rpc/${procedure}`, {
            method: "POST",
            headers: { [LOCAL_SETTINGS_TOKEN_HEADER]: token },
            body: "{}",
          })
        ).status,
      ).toBe(403);
    }
    expect(f.upsert).not.toHaveBeenCalled();
  });
  it("saves only a bounded host choice on the app-managed Docker instance", async () => {
    const f = fixture();
    expect((await f.request('{"computerHost":"this-mac"}')).status).toBe(200);
    expect(f.upsert).toHaveBeenCalledWith({
      where: { id: "default" },
      create: { id: "default", computerHost: "this-mac" },
      update: { computerHost: "this-mac" },
    });
    for (const body of ["null", "{", '{"computerHost":"remote"}'])
      expect((await f.request(body)).status).toBe(400);
    expect((await f.request("x".repeat(1025))).status).toBe(413);
    expect((await fixture("e2b").request('{"computerHost":"this-mac"}')).status).toBe(403);
    expect(f.upsert).toHaveBeenCalledTimes(1);
  });
});
