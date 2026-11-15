import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { trackInFlightRequests } from "./in-flight-requests.js";

describe("trackInFlightRequests", () => {
  it("settles only once running handlers finish", async () => {
    const inFlight = trackInFlightRequests();
    let finish!: () => void;
    const handlerDone = new Promise<void>((resolve) => (finish = resolve));
    const app = new Hono();
    app.use("*", inFlight.middleware);
    app.get("/slow", async (c) => {
      await handlerDone;
      return c.text("ok");
    });
    app.get("/fail", () => {
      throw new Error("boom");
    });

    const failed = await app.request("/fail");
    expect(failed.status).toBe(500);

    const response = app.request("/slow");
    let settled = false;
    const drained = inFlight.settled().then(() => (settled = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    finish();
    await drained;
    expect(settled).toBe(true);
    expect(await (await response).text()).toBe("ok");
    await expect(inFlight.settled()).resolves.toEqual([]);
  });
});
