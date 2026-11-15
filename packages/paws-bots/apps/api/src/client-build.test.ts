import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CLIENT_BUILD_HEADER,
  CLIENT_UPDATE_REQUIRED,
  SERVER_BUILD_HEADER,
} from "@rakazo/contracts";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { clientBuildMiddleware, readDeployedWebBuild } from "./client-build.js";

function app(webBuild: string | undefined, minimums = {}) {
  const hono = new Hono();
  hono.use("/rpc/*", clientBuildMiddleware({ webBuild, minimums }));
  hono.post("/rpc/me", (c) => c.json({ json: { ok: true } }));
  return hono;
}
const call = (hono: Hono, build?: string) =>
  hono.request("/rpc/me", {
    method: "POST",
    headers: build ? { [CLIENT_BUILD_HEADER]: build } : {},
  });

describe("client build handshake", () => {
  it("names the deployed web build on every reply", async () => {
    const response = await call(app("20261022093015"), "web/20261001000000");
    expect(response.status).toBe(200);
    expect(response.headers.get(SERVER_BUILD_HEADER)).toBe("20261022093015");
  });

  it("stays quiet without a known web build", async () => {
    const response = await call(app(undefined));
    expect(response.headers.get(SERVER_BUILD_HEADER)).toBeNull();
  });

  it("refuses a build older than its kind's minimum with a 426 RPC error", async () => {
    const hono = app("20261022093015", { web: "20261022000000" });
    const refused = await call(hono, "web/20261021235959");
    expect(refused.status).toBe(426);
    expect(refused.headers.get(SERVER_BUILD_HEADER)).toBe("20261022093015");
    expect(await refused.json()).toEqual({
      json: {
        defined: false,
        code: CLIENT_UPDATE_REQUIRED,
        status: 426,
        message: "Update required",
      },
    });
    expect((await call(hono, "web/20261022000000")).status).toBe(200);
    expect((await call(hono, "mobile/20200101000000")).status).toBe(200);
    expect((await call(hono)).status).toBe(200);
  });

  it("reads the web build id written beside the web assets", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rk-build-"));
    const file = path.join(dir, "build-id");
    writeFileSync(file, "20261022093015\n");
    expect(readDeployedWebBuild(pathToFileURL(file))).toBe("20261022093015");
    writeFileSync(file, "not-a-build");
    expect(readDeployedWebBuild(pathToFileURL(file))).toBeUndefined();
    expect(readDeployedWebBuild(pathToFileURL(path.join(dir, "missing")))).toBeUndefined();
  });
});
