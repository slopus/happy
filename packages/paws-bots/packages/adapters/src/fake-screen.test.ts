import { connect } from "node:net";
import {
  addScreenProxyCapability,
  openScreenCapability,
} from "@rakazo/core/node/screen-capability";
import { afterEach, describe, expect, it } from "vitest";
import { FakeScreenServer } from "./fake-screen.js";

const servers: FakeScreenServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function screenServer() {
  const server = new FakeScreenServer();
  servers.push(server);
  return server;
}

describe("FakeScreenServer", () => {
  it("serves a connected desktop page on loopback", async () => {
    const url = new URL(await screenServer().url("fake-bot", "default"));
    expect(url.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(url.pathname).toBe("/embed.html");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      computer: "fake-bot",
      screen: "default",
    });

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await response.text();
    expect(html).toContain('<html class="noVNC_connected"');
    expect(html).toContain("<head>");
    expect(html).not.toMatch(/<script|https?:\/\//);

    expect((await fetch(new URL("/other", url))).status).toBe(404);
    const malformed = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(url.port), url.hostname, () =>
        socket.end("GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
      );
      let reply = "";
      socket.on("data", (chunk) => {
        reply += chunk;
      });
      socket.on("end", () => resolve(reply));
      socket.on("error", reject);
    });
    expect(malformed).toMatch(/^HTTP\/1\.1 404/);
  });

  it("reuses one listener and stops serving once closed", async () => {
    const server = screenServer();
    const first = new URL(await server.url("a", "default"));
    const second = new URL(await server.url("b", "default"));
    expect(second.port).toBe(first.port);

    server.close();
    await expect(fetch(first)).rejects.toThrow();
  });

  it("is a screen the web proxy accepts", async () => {
    const url = await screenServer().url("fake-bot", "default");
    const sealed = new URL(
      addScreenProxyCapability(`${url}&view_only=true`, "secret", "http://app.test", {
        botId: "bot",
        computerId: "computer",
        botGeneration: 0,
        computerGeneration: 0,
        controlLeaseId: null,
      }),
    );
    expect(sealed.pathname).toMatch(/^\/novnc\/session\/view\/\d+\.[\w-]+\/embed\.html$/);
    const opened = openScreenCapability(`${sealed.pathname}${sealed.search}`, "secret");
    expect(opened?.target).toMatchObject({
      protocol: "http:",
      hostname: "127.0.0.1",
      port: Number(new URL(url).port),
      interactive: false,
    });
    expect(opened?.target.path).toMatch(/^\/embed\.html\?.*view_only=true/);
  });
});
