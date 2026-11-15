import {
  addScreenProxyCapability,
  SCREEN_TARGET_ENDPOINT,
} from "@rakazo/core/node/screen-capability";
import type { PrismaClient } from "@rakazo/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountScreenTarget } from "./screen-proxy.js";

const secret = "fake-screen-secret";
const scope = {
  botId: "bot",
  computerId: "computer",
  botGeneration: 0,
  computerGeneration: 0,
  controlLeaseId: "lease",
};
function fixture(
  interactive = false,
  upstream = `http://127.0.0.1:49152/embed.html?view_only=${!interactive}`,
  headers?: Record<string, string>,
) {
  const computer = {
    screenGeneration: 0,
    providerRef: "fake-provider",
    state: "running",
    controlHolder: "user",
    controlLeaseId: "lease",
    controlBotId: "bot",
    controlLeaseExpiresAt: new Date(Date.now() + 60_000),
  };
  const bot = {
    id: "bot",
    computerId: "computer",
    archivedAt: null as Date | null,
    screenGeneration: 0,
    computer,
  };
  const findFirst = vi.fn(async ({ where }) =>
    Object.entries(where).every(([key, value]) => bot[key as keyof typeof bot] === value)
      ? bot
      : null,
  );
  const app = new Hono();
  mountScreenTarget(app, { bot: { findFirst } } as unknown as PrismaClient, secret);
  const url = addScreenProxyCapability(
    upstream,
    secret,
    "https://app.example",
    scope,
    undefined,
    headers,
  );
  const path = new URL(url).pathname;
  const request = (value = path, credential = secret) =>
    app.request(SCREEN_TARGET_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ path: value }),
    });
  return { bot, computer, findFirst, path, request };
}

describe("screen capability lifecycle authorization", () => {
  it("returns sealed provider headers only after lifecycle authorization", async () => {
    const headers = { cookie: "provider_auth=fake-private-token" };
    const { request, path, computer } = fixture(false, undefined, headers);
    expect(path).not.toContain("fake-private-token");
    expect(await (await request()).json()).toMatchObject({ headers });
    expect((await request(path, "wrong")).status).toBe(403);
    computer.state = "stopped";
    expect((await request()).status).toBe(403);
  });

  it("allows repeat assets and reconnects during the same active lifecycle", async () => {
    const { request, path } = fixture();
    expect((await request()).status).toBe(200);
    expect((await request(path.replace("/embed.html", "/websockify"))).status).toBe(200);
    expect((await request()).headers.get("cache-control")).toBe("no-store");
  });
  it("requires the proxy credential before looking up a capability", async () => {
    const { request, findFirst, path } = fixture();
    expect((await request(path, "wrong")).status).toBe(403);
    expect(findFirst).not.toHaveBeenCalled();
  });
  it("rejects stopped computers and old URLs after restart at the same address", async () => {
    const { request, computer } = fixture();
    computer.state = "stopped";
    expect((await request()).status).toBe(403);
    computer.state = "running";
    computer.screenGeneration++;
    expect((await request()).status).toBe(403);
  });
  it("serves a booting or saving computer and rejects one with no sandbox", async () => {
    const { request, computer } = fixture();
    computer.state = "booting";
    expect((await request()).status).toBe(200);
    computer.state = "suspending";
    expect((await request()).status).toBe(200);
    computer.state = "running";
    expect((await request()).status).toBe(200);
    computer.providerRef = "";
    expect((await request()).status).toBe(403);
  });
  it.each(["suspended", "stopped", "error"])("rejects a computer in %s", async (state) => {
    const { request, computer } = fixture();
    computer.state = state;
    expect((await request()).status).toBe(403);
  });
  it.each(["generation", "control lease"])("still checks %s while saving", async (change) => {
    const { request, computer } = fixture(true);
    computer.state = "suspending";
    expect((await request()).status).toBe(200);
    if (change === "generation") computer.screenGeneration++;
    else computer.controlLeaseExpiresAt = new Date(0);
    expect((await request()).status).toBe(403);
  });
  it("revokes archived, reassigned, and restored bots", async () => {
    const { request, bot } = fixture();
    bot.archivedAt = new Date();
    expect((await request()).status).toBe(403);
    bot.archivedAt = null;
    bot.computerId = "other";
    expect((await request()).status).toBe(403);
    bot.computerId = "computer";
    bot.screenGeneration++;
    expect((await request()).status).toBe(403);
  });
  it.each(["expiry", "release", "replacement", "holder", "bot"])(
    "revokes control on lease %s",
    async (change) => {
      const { request, computer } = fixture(true);
      expect((await request()).status).toBe(200);
      if (change === "expiry") computer.controlLeaseExpiresAt = new Date(0);
      if (change === "release") computer.controlLeaseId = "";
      if (change === "replacement") computer.controlLeaseId = "new-lease";
      if (change === "holder") computer.controlHolder = "agent";
      if (change === "bot") computer.controlBotId = "other";
      expect((await request()).status).toBe(403);
    },
  );
  it("rejects legacy stateless capabilities", async () => {
    expect(
      (await fixture().request("/novnc/MTI3LjAuMC4x/49152/view/9999999999999.fake/embed.html"))
        .status,
    ).toBe(403);
  });
  // The web proxy rides out a 5xx as the API being down, so tampering must never produce one.
  it("refuses tampered capabilities with 403, never a server error", async () => {
    const { path, request, findFirst } = fixture(true);
    const [, , , policy, sealed] = path.split("/");
    const [expiry, token] = sealed!.split(".");
    const flipped = `${token!.slice(0, 20)}${token![20] === "A" ? "B" : "A"}${token!.slice(21)}`;
    const tampered = [
      path.replace(`/${policy}/`, policy === "control" ? "/view/" : "/control/"),
      path.replace(`/${expiry}.`, `/${Number(expiry) + 1}.`),
      path.replace(token!, flipped),
      path.replace(token!, token!.slice(0, 30)),
      path.replace(token!, "%%%"),
      path.replace(token!, ""),
      path.replace(`/${expiry}.`, "/1."),
      "/novnc/session/control/99999999999999999999999.abc/websockify",
    ];
    for (const value of tampered) expect((await request(value)).status).toBe(403);
    expect(findFirst).not.toHaveBeenCalled();
  });
  it("refuses a body that isn't a path with 403", async () => {
    const app = new Hono();
    mountScreenTarget(app, { bot: { findFirst: vi.fn() } } as unknown as PrismaClient, secret);
    for (const body of ["not json", "null", "{}", '{"path":1}', '{"path":["/novnc"]}']) {
      const response = await app.request(SCREEN_TARGET_ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(403);
    }
  });
  it("reuses one remote capability across polls and still revokes it", async () => {
    const upstream =
      "https://6100-sandbox.example/vnc.html?autoconnect=true&resize=scale&path=websockify%3Ftoken%3Dview-1&view_only=true";
    const { path, request, computer } = fixture(false, upstream);
    const again = new URL(addScreenProxyCapability(upstream, secret, "https://app.example", scope))
      .pathname;
    expect(again).toBe(path);
    expect((await request()).status).toBe(200);
    expect((await request(again.replace("/vnc.html", "/websockify"))).status).toBe(200);
    computer.screenGeneration++;
    expect((await request()).status).toBe(403);
  });
  it("keeps minting a new capability for loopback screens", () => {
    const upstream = "http://127.0.0.1:49152/embed.html?view_only=true";
    const first = addScreenProxyCapability(upstream, secret, "https://app.example", scope);
    const second = addScreenProxyCapability(upstream, secret, "https://app.example", scope);
    expect(new URL(first).pathname).not.toBe(new URL(second).pathname);
  });
  it("passes desktop and other non-http screen URLs through unsealed", () => {
    expect(
      addScreenProxyCapability("desktop://screen/computer", secret, "https://app.example", scope),
    ).toBe("desktop://screen/computer");
    expect(addScreenProxyCapability("local://preview", secret, "https://app.example", scope)).toBe(
      "local://preview",
    );
  });
});
