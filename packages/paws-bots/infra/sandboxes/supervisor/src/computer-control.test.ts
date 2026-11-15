import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { controlDesktop, MAX_COMPUTER_CONTROL_RESPONSE_BYTES } from "./computer-control.js";
import {
  publishedLoopbackControlHostPort,
  resolveComputerControlEndpoint,
} from "./computer-spec.js";
import {
  attemptComputerControl,
  preferComputerControl,
  shouldReplayComputerActions,
} from "./supervisor-logic.js";

const token = "test-computer-control-token";
const actions = [{ kind: "key" as const, key: "Enter" }];
const observation = { image: "ZmFrZQ==", mimeType: "image/png", width: 1, height: 1 };
const servers: http.Server[] = [];

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

describe("computer control HTTP boundary", () => {
  it.each([false, true])("preserves direct desktop responses (observe=%s)", async (observe) => {
    const requests: Array<{ url?: string; method?: string; authorization?: string; body: string }> =
      [];
    const result = { completed: 1, ...(observe ? { observation } : {}) };
    const origin = await listen(async (req, res) => {
      // Local tools probe new loopback ports with `GET /`, which no control call sends.
      if (req.method === "GET" && req.url === "/") {
        req.resume();
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({
        url: req.url,
        method: req.method,
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString(),
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
    });

    await expect(
      controlDesktop(
        { url: `${origin}/v1/desktop`, token },
        actions,
        ":2",
        "/tmp/test-profile",
        observe,
        25,
      ),
    ).resolves.toEqual(result);
    expect(requests).toEqual([
      {
        url: "/v1/desktop",
        method: "POST",
        authorization: `Bearer ${token}`,
        body: JSON.stringify({
          steps: [{ argv: ["env", "DISPLAY=:2", "xdotool", "key", "--clearmodifiers", "Return"] }],
          display: ":2",
          observe,
          settleMs: 25,
        }),
      },
    ]);
  });

  it("sends token-authenticated actions to the inspected host mapping without a container IP", async () => {
    const authorizations: Array<string | undefined> = [];
    const origin = await listen((req, res) => {
      // Local tools probe new loopback ports with `GET /`, which no control call sends.
      if (req.method === "GET" && req.url === "/") {
        req.resume();
        res.writeHead(404).end();
        return;
      }
      req.resume();
      authorizations.push(req.headers.authorization);
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ completed: 1 }));
    });
    const publishedHostPort = publishedLoopbackControlHostPort({
      "7070/tcp": [{ HostIp: "127.0.0.1", HostPort: new URL(origin).port }],
    });
    const endpoint = resolveComputerControlEndpoint({
      token,
      networkMode: "bridge",
      networks: {},
      publishedHostPort,
      requirePublishedHostPort: true,
    });
    expect(endpoint).toEqual({ url: `${origin}/v1/desktop`, token });
    if (!endpoint) throw new Error("expected a loopback endpoint");
    await expect(
      controlDesktop(endpoint, actions, ":1", "/tmp/test-profile", false, 0),
    ).resolves.toEqual({
      completed: 1,
    });
    await expect(
      controlDesktop(
        { ...endpoint, token: "wrong-token" },
        actions,
        ":1",
        "/tmp/test-profile",
        false,
        0,
      ),
    ).rejects.toThrow();
    expect(authorizations).toEqual([`Bearer ${token}`, "Bearer wrong-token"]);
  });

  it("rejects an oversized computer-control response before reading it", async () => {
    const origin = await listen((req, res) => {
      req.resume();
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(MAX_COMPUTER_CONTROL_RESPONSE_BYTES + 1),
      });
      res.end("{}");
    });

    await expect(
      controlDesktop(
        { url: `${origin}/v1/desktop`, token },
        actions,
        ":1",
        "/tmp/test-profile",
        false,
        0,
      ),
    ).rejects.toThrow(`exceeds ${MAX_COMPUTER_CONTROL_RESPONSE_BYTES} bytes`);
  });

  describe.each([301, 302, 303, 307, 308])("HTTP %s", (status) => {
    it.each(["same origin", "other origin"])(
      "never contacts a redirect target on the %s or replays actions",
      async (destination) => {
        const targetRequests: Array<{ method?: string; authorization?: string }> = [];
        const target: http.RequestListener = (req, res) => {
          // Local tools probe new loopback ports with `GET /`, which no control call or
          // redirect sends, so it is not recorded.
          if (req.method === "GET" && req.url === "/") {
            req.resume();
            res.writeHead(404).end();
            return;
          }
          targetRequests.push({ method: req.method, authorization: req.headers.authorization });
          // Even a response matching the control contract must never be accepted
          // from another endpoint. These servers are loopback-only fake services.
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ completed: 1, observation }));
        };
        const location =
          destination === "same origin" ? "/other-endpoint" : `${await listen(target)}/v1/desktop`;
        let controlRequests = 0;
        const origin = await listen((req, res) => {
          if (req.url !== "/v1/desktop") return target(req, res);
          controlRequests += 1;
          req.resume();
          res.writeHead(status, { location });
          res.end();
        });
        const endpoint = { url: `${origin}/v1/desktop`, token };

        const attempt = await attemptComputerControl(() =>
          controlDesktop(endpoint, actions, ":1", "/tmp/test-profile", false, 0),
        );
        expect(targetRequests).toEqual([]);
        expect(attempt.status).toBe("failed");
        expect(shouldReplayComputerActions(attempt)).toBe(false);

        // Observation may fall back to Docker exec on the original computer.
        const fallbackObservation = { source: "original-computer" };
        await expect(
          preferComputerControl(
            async () =>
              (await controlDesktop(endpoint, [], ":1", "/tmp/test-profile", true, 0)).observation,
            async () => fallbackObservation,
          ),
        ).resolves.toEqual(fallbackObservation);
        expect(targetRequests).toEqual([]);
        expect(controlRequests).toBe(2);
      },
    );
  });
});
