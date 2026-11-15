import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSupervisorToken } from "@rakazo/core";
import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";
import { resolveDockerSocketPath } from "./context.js";
import { supervisorApp } from "./index.js";
import { waitForScreenReady } from "./readiness.js";
import {
  MAX_SUPERVISOR_FILE_REQUEST_BYTES,
  MAX_SUPERVISOR_REQUEST_BYTES,
  supervisorFileWriteSchema,
  supervisorRequestBodyLimit,
} from "./request-limits.js";
import type { ScreenAssignment } from "./supervisor-logic.js";
import {
  AIMED_SCROLL_CONTROL_LABEL,
  assertRequestIdentity,
  attemptComputerControl,
  browserProfilePathForScreen,
  ComputerControlUnavailableError,
  clearComputerScreenRegistry,
  completeReleasedScreen,
  completeWarmReleasedScreen,
  computerCommandEnv,
  computerControlTimeoutMs,
  containerActionStep,
  containerActionSteps,
  controlHandlesActions,
  createComputerWithNameRetry,
  createDockerStreamDemuxer,
  currentComputerScreens,
  DOCKER_BROWSER_ALIASES,
  demuxDockerStream,
  ensureScreenCommand,
  hasComputerIdentity,
  hasValidBearerToken,
  interactiveScreenCommand,
  isComputerControlUnavailable,
  isManagedComputer,
  nextScreenIndex,
  normalizeWorkspaceRelative,
  oldestIdleScreen,
  pageBrowserNotReady,
  parseObservation,
  preferComputerControl,
  releaseAssignedScreen,
  removeOwnedComputer,
  resetManagedScreensCommand,
  SCREEN_REUSE_MS,
  sandboxCommandTimedOut,
  sandboxTimeoutCommand,
  screenRecentlyEnsured,
  screenReleaseStopCommand,
  shouldReplayComputerActions,
  stopExtraScreenCommand,
  teardownReleasedScreen,
  terminalCommand,
  withKeyedLock,
} from "./supervisor-logic.js";

const token = resolveSupervisorToken(process.env);

describe("computer screen readiness", () => {
  it("waits for the server to actually answer HTTP requests before succeeding", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP address");
    try {
      await expect(waitForScreenReady("127.0.0.1", address.port, 2_000)).resolves.toBe(true);
    } finally {
      server.close();
    }
  });

  it("does not treat an open TCP port as ready when nothing is serving HTTP on it yet", async () => {
    // A bare TCP accept (the port mapping up before websockify) is not ready:
    // that gap caused "socket hang up" in the browser.
    const server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP address");
    try {
      await expect(waitForScreenReady("127.0.0.1", address.port, 700)).resolves.toBe(false);
    } finally {
      server.close();
    }
  });

  it("does not treat HTTP error responses as ready", async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 503;
      res.end("starting");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP address");
    try {
      await expect(waitForScreenReady("127.0.0.1", address.port, 700)).resolves.toBe(false);
    } finally {
      server.close();
    }
  });

  it("does not treat redirect responses as ready", async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader("Location", "/vnc.html");
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP address");
    try {
      await expect(waitForScreenReady("127.0.0.1", address.port, 700)).resolves.toBe(false);
    } finally {
      server.close();
    }
  });

  it("times out instead of hanging when nothing is listening", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP address");
    const closedPort = address.port;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await expect(waitForScreenReady("127.0.0.1", closedPort, 700)).resolves.toBe(false);
  });
});

describe("sandbox supervisor Docker endpoint", () => {
  it("discovers the unprivileged Docker Desktop socket on macOS", () => {
    const home = mkdtempSync(path.join(tmpdir(), "rakazo-docker-home-"));
    try {
      expect(resolveDockerSocketPath({ HOME: home }, "darwin")).toBe("/var/run/docker.sock");
      const socket = path.join(home, ".docker", "run", "docker.sock");
      mkdirSync(path.dirname(socket), { recursive: true });
      writeFileSync(socket, "");
      expect(resolveDockerSocketPath({ HOME: home }, "darwin")).toBe(socket);
      expect(
        resolveDockerSocketPath({ HOME: home, DOCKER_SOCKET: "/tmp/override.sock" }, "darwin"),
      ).toBe("/tmp/override.sock");
      expect(
        resolveDockerSocketPath({ HOME: home, DOCKER_HOST: "tcp://docker.test:2375" }, "darwin"),
      ).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("respects Docker host and socket overrides before platform defaults", () => {
    expect(resolveDockerSocketPath({ DOCKER_HOST: "tcp://docker.test:2375" }, "win32")).toBe(
      undefined,
    );
    expect(resolveDockerSocketPath({ DOCKER_SOCKET: "/tmp/docker.sock" }, "win32")).toBe(
      "/tmp/docker.sock",
    );
    expect(resolveDockerSocketPath({}, "win32")).toBe("//./pipe/docker_engine");
    expect(resolveDockerSocketPath({}, "linux")).toBe("/var/run/docker.sock");
  });
});

describe("sandbox supervisor HTTP boundary", () => {
  it("keeps health public while every computer route requires the service token", async () => {
    const health = await supervisorApp.request("/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ ok: true });

    const protectedRequests: Array<[string, string]> = [
      ["POST", "/computers"],
      ["GET", "/computers/id"],
      ["POST", "/computers/id/exec"],
      ["POST", "/computers/id/observe"],
      ["POST", "/computers/id/actions"],
      ["POST", "/computers/id/browser"],
      ["GET", "/computers/id/files"],
      ["POST", "/computers/id/files"],
      ["GET", "/computers/id/screen"],
      ["POST", "/computers/id/screen-mode"],
      ["POST", "/computers/id/terminal"],
      ["DELETE", "/computers/id/screen"],
      ["POST", "/computers/id/input"],
      ["POST", "/computers/id/stop"],
      ["DELETE", "/computers/id"],
    ];

    for (const [method, pathname] of protectedRequests) {
      const response = await supervisorApp.request(pathname, { method });
      expect(response.status, `${method} ${pathname}`).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    }
  });

  it("rejects malformed and incorrect bearer credentials", () => {
    expect(hasValidBearerToken(undefined, token)).toBe(false);
    expect(hasValidBearerToken(token, token)).toBe(false);
    expect(hasValidBearerToken("Basic credentials", token)).toBe(false);
    expect(hasValidBearerToken(`Bearer ${"x".repeat(token.length)}`, token)).toBe(false);
    expect(hasValidBearerToken(`Bearer ${token}`, token)).toBe(true);
    expect(hasValidBearerToken(`bearer ${token}`, token)).toBe(true);
    expect(hasValidBearerToken(`BEARER ${token}`, token)).toBe(true);
    expect(hasValidBearerToken(`bEaReR ${token}`, token)).toBe(true);
    expect(hasValidBearerToken("bearer Secret-token", "secret-token")).toBe(false);
    expect(hasValidBearerToken(`Bearer${token}`, token)).toBe(false);
    expect(hasValidBearerToken(`Bearer  ${token}`, token)).toBe(false);
    expect(hasValidBearerToken(`Bearer\t${token}`, token)).toBe(false);
    expect(hasValidBearerToken(`Bearer ${token}x`, token)).toBe(false);
    expect(hasValidBearerToken(`Bearer ${token.slice(0, -1)}`, token)).toBe(false);
  });

  it("bounds authenticated control request bodies before JSON parsing", async () => {
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    const declared = await supervisorApp.request("/computers/id/actions", {
      method: "POST",
      headers: {
        ...headers,
        "content-length": String(MAX_SUPERVISOR_REQUEST_BYTES + 1),
      },
      body: "{}",
    });
    const streamed = await supervisorApp.request("/computers/id/actions", {
      method: "POST",
      headers,
      body: JSON.stringify({ padding: "x".repeat(MAX_SUPERVISOR_REQUEST_BYTES) }),
    });

    for (const response of [declared, streamed]) {
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: "Request body is too large." });
    }
  });

  it("allows configured uploads through both the file schema and body guard", () => {
    const limit = 25 * 1024 * 1024;
    const content = Buffer.alloc(20 * 1024 * 1024).toString("base64");
    const payload = { path: "attachments/large.txt", content };
    expect(supervisorFileWriteSchema(limit).safeParse(payload).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(
      supervisorRequestBodyLimit("POST", "/computers/id/files", limit),
    );
    expect(supervisorFileWriteSchema().safeParse(payload).success).toBe(false);
    expect(
      supervisorFileWriteSchema(limit).safeParse({
        path: "large.txt",
        content: "A".repeat(Math.ceil(limit / 3) * 4 + 1),
      }).success,
    ).toBe(false);
    expect(supervisorRequestBodyLimit("POST", "/computers/id/actions", limit)).toBe(
      MAX_SUPERVISOR_REQUEST_BYTES,
    );
  });

  it("keeps the larger file-write allowance scoped to that exact POST route", () => {
    expect(supervisorRequestBodyLimit("POST", "/computers/id/files")).toBe(
      MAX_SUPERVISOR_FILE_REQUEST_BYTES,
    );
    expect(supervisorRequestBodyLimit("POST", "/computers/id/files/")).toBe(
      MAX_SUPERVISOR_FILE_REQUEST_BYTES,
    );
    expect(supervisorRequestBodyLimit("PUT", "/computers/id/files")).toBe(
      MAX_SUPERVISOR_REQUEST_BYTES,
    );
    expect(supervisorRequestBodyLimit("POST", "/computers/id/actions")).toBe(
      MAX_SUPERVISOR_REQUEST_BYTES,
    );
    expect(supervisorRequestBodyLimit("POST", "/computers/files")).toBe(
      MAX_SUPERVISOR_REQUEST_BYTES,
    );
    expect(supervisorRequestBodyLimit("POST", "/computers/id/files/extra")).toBe(
      MAX_SUPERVISOR_REQUEST_BYTES,
    );
  });

  it("rejects terminal requests without a well-formed control token before touching Docker", async () => {
    for (const body of [{}, { controlToken: "bad token" }, { controlToken: "a".repeat(129) }]) {
      const response = await supervisorApp.request("/computers/id/terminal", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(response.ok).toBe(false);
    }
  });

  it("rejects a provision request whose identity headers do not match its body", async () => {
    const response = await supervisorApp.request("/computers", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": "other-bot",
        "x-rakazo-space-id": "workspace",
      },
      body: JSON.stringify({
        botId: "bot",
        spaceId: "workspace",
        homePath: "/tmp/never-used",
      }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "computer identity mismatch" });
  });
});

describe("sandbox supervisor input containment", () => {
  it("normalizes portable paths and rejects lexical traversal", () => {
    expect(normalizeWorkspaceRelative("/notes\\result.txt")).toBe("notes/result.txt");
    expect(normalizeWorkspaceRelative("//notes///result.txt")).toBe("notes/result.txt");
    expect(() => normalizeWorkspaceRelative("../outside")).toThrow(/escapes/);
    expect(() => normalizeWorkspaceRelative("notes/./result.txt")).toThrow(/escapes/);
    expect(() => normalizeWorkspaceRelative("notes/../outside")).toThrow(/escapes/);
  });

  it("requires both bot and workspace identities to match", () => {
    expect(() =>
      assertRequestIdentity("bot", "workspace", { botId: "bot", spaceId: "workspace" }),
    ).not.toThrow();
    expect(() =>
      assertRequestIdentity(undefined, "workspace", { botId: "bot", spaceId: "workspace" }),
    ).toThrow(/identity mismatch/);
    expect(() =>
      assertRequestIdentity("bot", "other", { botId: "bot", spaceId: "workspace" }),
    ).toThrow(/identity mismatch/);
  });

  it("accepts the legacy workspace label without weakening container identity", () => {
    expect(
      hasComputerIdentity({ "rakazo.botId": "bot", "rakazo.workspaceId": "space" }, "bot", "space"),
    ).toBe(true);
    expect(
      hasComputerIdentity(
        { "rakazo.botId": "bot", "rakazo.workspaceId": "other-space" },
        "bot",
        "space",
      ),
    ).toBe(false);
    expect(
      hasComputerIdentity(
        {
          "rakazo.botId": "bot",
          "rakazo.spaceId": "space",
          "rakazo.workspaceId": "other-space",
        },
        "bot",
        "space",
      ),
    ).toBe(true);
  });

  it("bounds scroll and wait actions before sending them to the computer", () => {
    expect(containerActionStep({ kind: "wait", ms: 99_999 })).toEqual({ waitMs: 5_000 });
    expect(containerActionStep({ kind: "wait", ms: -1 })).toEqual({ waitMs: 0 });
    expect(containerActionStep({ kind: "scroll", direction: "up", amount: 99 })).toEqual({
      argv: ["env", "DISPLAY=:1", "xdotool", "click", "--repeat", "20", "4"],
    });
  });

  it("sends aimed and sideways scrolls to a computer's control service only when it takes them", () => {
    const plain = [
      { kind: "scroll" as const, direction: "down" as const, amount: 3 },
      { kind: "pointer" as const, x: 10, y: 20, type: "click" as const },
    ];
    const aimed = [{ kind: "scroll" as const, direction: "down" as const, x: 600, y: 420 }];
    const sideways = [{ kind: "scroll" as const, direction: "left" as const }];
    const current = { [AIMED_SCROLL_CONTROL_LABEL]: "1", "rakazo.botId": "bot" };
    const older = { "rakazo.botId": "bot" };
    expect(controlHandlesActions(older, plain)).toBe(true);
    expect(controlHandlesActions(older, aimed)).toBe(false);
    expect(controlHandlesActions(older, sideways)).toBe(false);
    expect(controlHandlesActions(undefined, [...plain, ...aimed])).toBe(false);
    expect(controlHandlesActions(current, [...plain, ...aimed, ...sideways])).toBe(true);
    // The computer image built with this control service carries the label.
    const dockerfile = readFileSync(
      path.resolve(import.meta.dirname, "../../computer/Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain(`LABEL ${AIMED_SCROLL_CONTROL_LABEL}="1"`);
  });

  it("moves the pointer to a scroll's point before turning the wheel", () => {
    expect(
      containerActionStep({ kind: "scroll", direction: "down", amount: 4, x: 600.4, y: 420 }),
    ).toEqual({
      argv: [
        "env",
        "DISPLAY=:1",
        "xdotool",
        "mousemove",
        "--",
        "600",
        "420",
        "click",
        "--repeat",
        "4",
        "5",
      ],
    });
    expect(containerActionStep({ kind: "scroll", direction: "left", amount: 2 })).toEqual({
      argv: ["env", "DISPLAY=:1", "xdotool", "click", "--repeat", "2", "6"],
    });
    expect(containerActionStep({ kind: "scroll", direction: "right", amount: 2 })).toEqual({
      argv: ["env", "DISPLAY=:1", "xdotool", "click", "--repeat", "2", "7"],
    });
    // Both coordinates or neither: a lone x scrolls where the pointer is.
    expect(containerActionStep({ kind: "scroll", direction: "down", x: 600 })).toEqual({
      argv: ["env", "DISPLAY=:1", "xdotool", "click", "--repeat", "3", "5"],
    });
  });

  it.each([undefined, "/home/rakazo/.browser-profiles/bot-test"])(
    "opens workspace files in the assigned browser (profile=%s)",
    (profile) => {
      for (const [file, url] of [
        ["screenshots/it's #1%.png", "file:///home/rakazo/screenshots/it's%20%231%25.png"],
        ["/image.png", "file:///home/rakazo/image.png"],
        ["screenshots/back\\slash.png", "file:///home/rakazo/screenshots/back/slash.png"],
      ] as const) {
        expect(containerActionStep({ kind: "open", path: file }, ":2", profile)).toEqual({
          argv: [
            "env",
            "DISPLAY=:2",
            ...(profile ? [`RAKAZO_BROWSER_PROFILE=${profile}`] : []),
            "rakazo-browser",
            url,
          ],
        });
      }
    },
  );

  it("routes Docker browser aliases through the safe wrapper on every display", () => {
    for (const application of DOCKER_BROWSER_ALIASES) {
      expect(
        containerActionStep({ kind: "launch", application, uri: "https://example.com" }, ":2"),
      ).toEqual({
        argv: ["env", "DISPLAY=:2", "rakazo-browser", "https://example.com"],
      });
    }
    expect(containerActionStep({ kind: "launch", application: "xterm" }, ":3")).toEqual({
      argv: ["env", "DISPLAY=:3", "xterm"],
    });
    expect(containerActionStep({ kind: "open", path: "https://example.com" }, ":3")).toEqual({
      argv: ["env", "DISPLAY=:3", "xdg-open", "https://example.com"],
    });
  });

  it("routes focus actions through the focus-or-launch wrapper", () => {
    expect(containerActionStep({ kind: "focus", application: "xterm" }, ":3")).toEqual({
      argv: ["env", "DISPLAY=:3", "rakazo-focus-or-launch", "xterm"],
    });
    expect(
      containerActionStep(
        { kind: "focus", application: "chromium", uri: "https://example.com" },
        ":2",
      ),
    ).toEqual({
      argv: [
        "env",
        "DISPLAY=:2",
        "rakazo-focus-or-launch",
        "rakazo-browser",
        "https://example.com",
      ],
    });
    const profile = browserProfilePathForScreen("writer");
    expect(containerActionStep({ kind: "focus", application: "chromium" }, ":2", profile)).toEqual({
      argv: [
        "env",
        "DISPLAY=:2",
        `RAKAZO_BROWSER_PROFILE=${profile}`,
        "rakazo-focus-or-launch",
        "rakazo-browser",
      ],
    });
    // A non-browser application never receives the per-screen browser profile.
    expect(containerActionStep({ kind: "focus", application: "xterm" }, ":2", profile)).toEqual({
      argv: ["env", "DISPLAY=:2", "rakazo-focus-or-launch", "xterm"],
    });
  });

  it("routes mixed-case Docker browser aliases through the safe wrapper", () => {
    for (const application of ["Chrome", "Firefox", "Chromium", "Google-Chrome"]) {
      expect(
        containerActionStep({ kind: "launch", application, uri: "https://example.com" }, ":2"),
      ).toEqual({
        argv: ["env", "DISPLAY=:2", "rakazo-browser", "https://example.com"],
      });
    }
    expect(containerActionStep({ kind: "launch", application: "XTerm" }, ":3")).toEqual({
      argv: ["env", "DISPLAY=:3", "XTerm"],
    });
  });

  it("keeps browser routing argv identical for control and Docker exec fallback", () => {
    const action = { kind: "launch" as const, application: "chromium", uri: "https://example.com" };
    const profile = browserProfilePathForScreen("writer");
    expect(containerActionSteps([action], ":2", profile)).toEqual([
      {
        argv: [
          "env",
          "DISPLAY=:2",
          `RAKAZO_BROWSER_PROFILE=${profile}`,
          "rakazo-browser",
          "https://example.com",
        ],
      },
    ]);
    expect(
      containerActionSteps([{ kind: "open", path: "https://example.com" }], ":2", profile),
    ).toEqual([
      {
        argv: [
          "env",
          "DISPLAY=:2",
          `RAKAZO_BROWSER_PROFILE=${profile}`,
          "xdg-open",
          "https://example.com",
        ],
      },
    ]);
  });

  it("falls back to docker-exec when computer control fails", async () => {
    await expect(
      preferComputerControl(
        async () => {
          throw new Error("connection refused");
        },
        async () => "docker-exec",
      ),
    ).resolves.toBe("docker-exec");
    await expect(preferComputerControl(undefined, async () => "docker-exec")).resolves.toBe(
      "docker-exec",
    );
    await expect(
      preferComputerControl(
        async () => "fast-path",
        async () => "docker-exec",
      ),
    ).resolves.toBe("fast-path");
  });

  it("replays actions only when control was never reached", async () => {
    await expect(attemptComputerControl(undefined)).resolves.toEqual({ status: "unavailable" });
    await expect(
      attemptComputerControl(async () => {
        throw new ComputerControlUnavailableError("fetch failed");
      }),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(
      attemptComputerControl(async () => {
        throw new Error("computer action failed");
      }),
    ).resolves.toMatchObject({ status: "failed" });
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    await expect(
      attemptComputerControl(async () => {
        throw timeout;
      }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(isComputerControlUnavailable(new TypeError("fetch failed"))).toBe(false);
    expect(
      isComputerControlUnavailable(
        Object.assign(new TypeError("fetch failed"), {
          cause: new Error("connect ECONNREFUSED 127.0.0.1:7070"),
        }),
      ),
    ).toBe(true);
    expect(
      isComputerControlUnavailable(
        Object.assign(new TypeError("fetch failed"), {
          cause: new Error("connect ENETUNREACH 172.18.0.4:7070"),
        }),
      ),
    ).toBe(true);
    expect(
      isComputerControlUnavailable(
        Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(
            new Error(
              "Connect Timeout Error (attempted address: 172.20.0.2:7070, timeout: 10000ms)",
            ),
            { name: "ConnectTimeoutError", code: "UND_ERR_CONNECT_TIMEOUT" },
          ),
        }),
      ),
    ).toBe(true);
    expect(
      isComputerControlUnavailable(
        Object.assign(new TypeError("fetch failed"), {
          cause: new Error("read ECONNRESET"),
        }),
      ),
    ).toBe(false);
    expect(isComputerControlUnavailable(timeout)).toBe(false);
    await expect(attemptComputerControl(async () => ({ completed: 2 }))).resolves.toEqual({
      status: "ok",
      value: { completed: 2 },
    });
  });

  it("falls back on connection refused but does not replay after a request-sent failure", async () => {
    const refused = await attemptComputerControl(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: new Error("connect ECONNREFUSED 172.18.0.4:7070"),
      });
    });
    expect(refused).toEqual({ status: "unavailable" });
    expect(shouldReplayComputerActions(refused)).toBe(true);

    const afterWrite = await attemptComputerControl(async () => {
      throw new Error("computer control failed");
    });
    expect(afterWrite).toMatchObject({ status: "failed" });
    expect(shouldReplayComputerActions(afterWrite)).toBe(false);

    const timedOut = await attemptComputerControl(async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      });
    });
    expect(timedOut).toMatchObject({ status: "failed" });
    expect(shouldReplayComputerActions(timedOut)).toBe(false);

    const reset = await attemptComputerControl(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: new Error("read ECONNRESET"),
      });
    });
    expect(reset).toMatchObject({ status: "failed" });
    expect(shouldReplayComputerActions(reset)).toBe(false);
  });

  it("extends the computer control deadline for mapped waits and focus steps", () => {
    expect(computerControlTimeoutMs([])).toBe(15_000);
    expect(computerControlTimeoutMs([{ kind: "wait", ms: 5_000 }], 5_000)).toBe(25_000);
    const focus = { kind: "focus" as const, application: "xterm" };
    expect(computerControlTimeoutMs([focus])).toBe(15_000 + 13_400);
    expect(computerControlTimeoutMs([focus, { kind: "wait", ms: 1_000 }], 500)).toBe(
      15_000 + 13_400 + 1_000 + 500,
    );
    // Five focus steps need 15s + 67s. The deadline is that sum, not the old 60s clip.
    expect(computerControlTimeoutMs(Array.from({ length: 5 }, () => focus))).toBe(
      15_000 + 5 * 13_400,
    );
    expect(
      computerControlTimeoutMs(
        Array.from({ length: 24 }, () => focus),
        5_000,
      ),
    ).toBe(15_000 + 24 * 13_400 + 5_000);
    expect(
      computerControlTimeoutMs(
        Array.from({ length: 10 }, () => ({ kind: "wait" as const, ms: 5_000 })),
        5_000,
      ),
    ).toBe(15_000 + 10 * 5_000 + 5_000);
  });

  it("wraps sandbox commands in a process-tree timeout", () => {
    expect(sandboxTimeoutCommand(["bash", "-lc", "sleep 10"], 2_500, "/tmp/completed-124")).toEqual(
      [
        "timeout",
        "--kill-after=1s",
        "2.5s",
        "sh",
        "-c",
        '"$@"; status=$?; if [ "$status" -eq 124 ]; then : > "$0"; fi; exit "$status"',
        "/tmp/completed-124",
        "bash",
        "-lc",
        "sleep 10",
      ],
    );
    expect(sandboxCommandTimedOut(124, false)).toBe(true);
    expect(sandboxCommandTimedOut(124, true)).toBe(false);
    expect(sandboxCommandTimedOut(1, false)).toBe(false);
  });

  it("keeps the viewer read-only and uses a separate process for takeover control", () => {
    expect(interactiveScreenCommand(false)).toMatch(/pkill .*sockets\/control-1-/);
    expect(interactiveScreenCommand(false)).not.toMatch(/x11vnc -display/);
    expect(interactiveScreenCommand(true, "lease-new")).toMatch(
      /x11vnc -display .* -rfbport 0 -unixsock .*control-1-/,
    );
    expect(interactiveScreenCommand(true, "lease-new")).toMatch(/6080/);
    expect(interactiveScreenCommand(true, "lease-new")).toContain("0.0.0.0:6080 8>&-");
    expect(terminalCommand("control", "terminal", "/work")).toContain("0.0.0.0:6080 8>&-");
    expect(interactiveScreenCommand(true, "lease-new")).not.toContain("sockets/view-1-");
    expect(interactiveScreenCommand(false, "lease-old")).toContain("= 'lease-old'");
    expect(interactiveScreenCommand(false, "lease-old")).toContain("RAKAZO_CONTROL_RELEASED");
  });

  it("assigns distinct screen indexes per Team bot and starts extra displays", () => {
    const assigned = new Map<string, ScreenAssignment>();
    expect(nextScreenIndex(assigned, "writer")).toBe(0);
    expect(nextScreenIndex(assigned, "researcher")).toBe(1);
    expect(nextScreenIndex(assigned, "writer")).toBe(0);
    expect(ensureScreenCommand(0, "writer", "view-token")).toContain("-display :1");
    expect(ensureScreenCommand(0, "writer", "view-token")).toContain("seq 1 100");
    expect(ensureScreenCommand(1, "researcher", "view-token")).toContain("Xvfb :2");
    expect(ensureScreenCommand(1, "researcher", "view-token")).toContain("sockets/view-2-");
    expect(ensureScreenCommand(1, "researcher", "view-token")).toContain("0.0.0.0:6080");
    expect(() => nextScreenIndex(assigned, "overflow", undefined, 1)).toThrow(
      /cannot allocate another screen/,
    );
  });

  it("generates syntactically valid shell to start an extra display", () => {
    for (const command of [
      ensureScreenCommand(0, "writer", "view-token"),
      ensureScreenCommand(1, "researcher", "view-token"),
      stopExtraScreenCommand(0, "writer"),
      stopExtraScreenCommand(1, "researcher"),
      interactiveScreenCommand(false, "lease-old"),
      interactiveScreenCommand(true, "lease-new"),
      resetManagedScreensCommand(),
    ]) {
      const result = spawnSync("bash", ["-n"], { input: command });
      expect(result.status).toBe(0);
      expect(result.stderr.toString()).toBe("");
    }
  });

  it("serializes screen lifecycle operations by container", async () => {
    const locks = new Map<string, Promise<void>>();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withKeyedLock(locks, "container-1", async () => {
      events.push("ensure:start");
      await firstBlocked;
      events.push("ensure:end");
    });
    const release = withKeyedLock(locks, "container-1", async () => {
      events.push("release");
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["ensure:start"]);
    releaseFirst();
    await Promise.all([first, release]);
    expect(events).toEqual(["ensure:start", "ensure:end", "release"]);
    expect(locks.size).toBe(0);
  });

  it("resets stale managed screens without killing unrelated container jobs", () => {
    const command = resetManagedScreensCommand();
    expect(command).toContain("chromium-bot-*");
    expect(command).toContain("for marker in /tmp/rakazo/browser-profile-*");
    expect(command).toContain("/tmp/rakazo/browser-pid-*");
    expect(command).not.toContain("pkill -9 -1");
  });

  it("keeps a persistent independent profile per bot across display slots", () => {
    const writer = browserProfilePathForScreen("writer");
    const researcher = browserProfilePathForScreen("researcher");
    const command = ensureScreenCommand(0, "writer", "view-token");

    expect(writer).not.toBe(researcher);
    expect(command).toContain(writer);
    expect(ensureScreenCommand(3, "writer", "view-token")).toContain(writer);
    expect(ensureScreenCommand(0, "researcher", "view-token")).toContain(researcher);
    expect(command).not.toContain("/home/rakazo/.browser-profiles/chromium/.");
    expect(command).not.toContain(".rakazo-base-generation");
    expect(command).toContain("browser-pid-");
    expect(command).toContain("tr '\\0' '\\n' <\"/proc/$1/cmdline\"");
    expect(browserProfilePathForScreen("../../writer")).toMatch(
      /^\/home\/rakazo\/\.browser-profiles\/chromium-bot-[0-9a-f]+$/,
    );
  });

  it("allocates a thousand bots without a configured cap", () => {
    const assigned = new Map<string, ScreenAssignment>();
    for (let index = 0; index < 1000; index++)
      expect(nextScreenIndex(assigned, `bot-${index}`)).toBe(index);
  });

  it("trusts a screen's setup for a short time unless it is released or human-held", () => {
    const now = 1_000_000;
    expect(screenRecentlyEnsured({ index: 0, ensuredAt: now }, now + SCREEN_REUSE_MS - 1)).toBe(
      true,
    );
    expect(screenRecentlyEnsured({ index: 0, ensuredAt: now }, now + SCREEN_REUSE_MS)).toBe(false);
    expect(screenRecentlyEnsured({ index: 0 }, now)).toBe(false);
    expect(screenRecentlyEnsured({ index: 0, ensuredAt: now, controlled: true }, now)).toBe(false);
    expect(screenRecentlyEnsured({ index: 0, ensuredAt: now, controlToken: "token" }, now)).toBe(
      false,
    );
    const assigned = new Map<string, ScreenAssignment>([["bot", { index: 0, ensuredAt: now }]]);
    releaseAssignedScreen(assigned, "bot");
    completeWarmReleasedScreen(assigned, "bot", 0, now);
    expect(screenRecentlyEnsured(assigned.get("bot"), now)).toBe(false);
  });

  it("recognizes only a page helper that reached no browser before acting", () => {
    const output = (value: object) => ({ code: 0, stdout: JSON.stringify(value) });
    expect(pageBrowserNotReady(output({ ok: false, error: "CDP not ready on port 9222: x" }))).toBe(
      true,
    );
    expect(
      pageBrowserNotReady(output({ ok: false, error: "CDP not ready", uncertain: true })),
    ).toBe(false);
    expect(pageBrowserNotReady(output({ ok: false, error: "Element not found" }))).toBe(false);
    expect(pageBrowserNotReady(output({ ok: true }))).toBe(false);
    expect(pageBrowserNotReady({ code: 1, stdout: "" })).toBe(false);
    expect(pageBrowserNotReady({ code: 0, stdout: "not json" })).toBe(false);
  });

  it("frees a released screen slot so a ninth Team bot can reuse it", () => {
    const assigned = new Map<string, ScreenAssignment>();
    for (let index = 0; index < 8; index += 1) {
      expect(nextScreenIndex(assigned, `bot-${index}`)).toBe(index);
    }
    expect(() => nextScreenIndex(assigned, "bot-8", undefined, 8)).toThrow(
      /cannot allocate another screen/,
    );
    expect(releaseAssignedScreen(assigned, "bot-3")).toBe(3);
    expect(assigned.get("bot-0")?.index).toBe(0);
    expect(assigned.get("bot-3")?.releasing).toBe(true);
    expect(() => nextScreenIndex(assigned, "bot-3")).toThrow(/still being released/);
    expect(() => nextScreenIndex(assigned, "bot-8", undefined, 8)).toThrow(
      /cannot allocate another screen/,
    );
    completeReleasedScreen(assigned, "bot-3", 3);
    expect(assigned.get("bot-3")).toBeUndefined();
    expect(nextScreenIndex(assigned, "bot-8")).toBe(3);
    expect(nextScreenIndex(assigned, "bot-0")).toBe(0);
    expect(releaseAssignedScreen(assigned, "missing")).toBeUndefined();
    expect(nextScreenIndex(assigned, "bot-9")).toBe(8);
  });

  it.each([false, true])(
    "retains a screen slot when teardown fails (retainBrowser=%s)",
    async (retainBrowser) => {
      const assigned = new Map<string, ScreenAssignment>();
      expect(nextScreenIndex(assigned, "writer")).toBe(0);
      expect(releaseAssignedScreen(assigned, "writer")).toBe(0);

      await expect(
        teardownReleasedScreen(
          assigned,
          "writer",
          0,
          async () => ({
            code: 1,
            stderr: "browser still running",
          }),
          { retainBrowser },
        ),
      ).rejects.toThrow("browser still running");

      expect(assigned.get("writer")).toEqual({ index: 0, releasing: true });
      expect(() => nextScreenIndex(assigned, "writer")).toThrow(/still being released/);
      expect(nextScreenIndex(assigned, "researcher")).toBe(1);
      expect(releaseAssignedScreen(assigned, "writer")).toBe(0);
    },
  );

  it("clears all screen assignments when a container stops so slots can be reused", () => {
    const registry = new Map<string, Map<string, ScreenAssignment>>();
    const containerId = "container-1";
    const assigned = new Map<string, ScreenAssignment>();
    registry.set(containerId, assigned);
    for (let index = 0; index < 8; index += 1) {
      nextScreenIndex(assigned, `bot-${index}`);
    }
    expect(() => nextScreenIndex(assigned, "bot-8", undefined, 8)).toThrow(
      /cannot allocate another screen/,
    );

    const boots = new Map([
      [containerId, "boot-1"],
      ["other-container", "boot-2"],
    ]);
    clearComputerScreenRegistry(registry, boots, containerId);
    expect(registry.has(containerId)).toBe(false);
    expect(boots.has(containerId)).toBe(false);
    expect(boots.get("other-container")).toBe("boot-2");
    // Cleanup also removes a marker if the registry is already absent.
    clearComputerScreenRegistry(registry, boots, "other-container");
    expect(boots.size).toBe(0);

    const fresh = new Map<string, ScreenAssignment>();
    registry.set(containerId, fresh);
    for (let index = 0; index < 8; index += 1) {
      expect(nextScreenIndex(fresh, `bot-fresh-${index}`)).toBe(index);
    }
  });

  it("drops a screen registry recorded before the container restarted", () => {
    const registry = new Map<string, Map<string, ScreenAssignment>>();
    const boots = new Map<string, string>();
    const containerId = "container-1";
    const assigned = new Map<string, ScreenAssignment>();
    registry.set(containerId, assigned);
    boots.set(containerId, "2026-10-11T18:00:00.000Z");
    expect(nextScreenIndex(assigned, "writer")).toBe(0);
    // The container died mid-release (e.g. OOM kill): the slot is stuck releasing.
    expect(releaseAssignedScreen(assigned, "writer")).toBe(0);
    expect(() => nextScreenIndex(assigned, "writer")).toThrow(/still being released/);

    expect(currentComputerScreens(registry, boots, containerId, "2026-10-11T18:00:00.000Z")).toBe(
      assigned,
    );
    expect(currentComputerScreens(registry, boots, containerId, undefined)).toBe(assigned);

    expect(
      currentComputerScreens(registry, boots, containerId, "2026-10-11T18:19:21.000Z"),
    ).toBeUndefined();
    expect(registry.has(containerId)).toBe(false);
    expect(boots.has(containerId)).toBe(false);
  });

  it("keeps a registry whose boot was never recorded", () => {
    const registry = new Map<string, Map<string, ScreenAssignment>>();
    const assigned = new Map<string, ScreenAssignment>();
    registry.set("container-1", assigned);
    expect(
      currentComputerScreens(registry, new Map(), "container-1", "2026-10-11T18:19:21.000Z"),
    ).toBe(assigned);
  });

  it("does not release a screen reclaimed by a newer execution fence", () => {
    const assigned = new Map<string, ScreenAssignment>();
    expect(nextScreenIndex(assigned, "writer", "run-1:1")).toBe(0);
    expect(nextScreenIndex(assigned, "writer", "run-2:2")).toBe(0);
    expect(releaseAssignedScreen(assigned, "writer", "run-1:1")).toBeUndefined();
    expect(nextScreenIndex(assigned, "researcher")).toBe(1);
    expect(releaseAssignedScreen(assigned, "writer", "run-2:2")).toBe(0);
    completeReleasedScreen(assigned, "writer", 0);
  });

  it("retains warm slots, clears their idle marker on reuse, and evicts only the oldest idle Team slot", () => {
    const assigned = new Map<string, ScreenAssignment>();
    expect(nextScreenIndex(assigned, "writer", "run-1:1")).toBe(0);
    assigned.get("writer")!.viewToken = "view-token";
    expect(releaseAssignedScreen(assigned, "writer", "run-1:1")).toBe(0);
    completeWarmReleasedScreen(assigned, "writer", 0, 100);

    expect(assigned.get("writer")).toEqual({
      index: 0,
      leaseId: "run-1:1",
      viewToken: "view-token",
      idleAt: 100,
    });
    expect(nextScreenIndex(assigned, "researcher", "team-run:1", 3)).toBe(1);
    expect(releaseAssignedScreen(assigned, "researcher", "team-run:1")).toBe(1);
    completeWarmReleasedScreen(assigned, "researcher", 1, 200);
    expect(nextScreenIndex(assigned, "controlled", "run-controlled:1", 3)).toBe(2);
    assigned.get("controlled")!.controlled = true;
    assigned.get("controlled")!.idleAt = 50;
    expect(oldestIdleScreen(assigned, 3)).toBe("writer");

    expect(nextScreenIndex(assigned, "writer", "run-2:2", 3)).toBe(0);
    expect(assigned.get("writer")?.idleAt).toBeUndefined();
    expect(oldestIdleScreen(assigned, 3)).toBe("researcher");
    expect(releaseAssignedScreen(assigned, "writer", "run-1:1")).toBeUndefined();
    expect(assigned.get("writer")?.releasing).toBeUndefined();
  });

  it("keeps a warm slot evictable when a viewer repeats the completed run lease", () => {
    const assigned = new Map<string, ScreenAssignment>();
    expect(nextScreenIndex(assigned, "writer", "run-1:1", 1)).toBe(0);
    expect(releaseAssignedScreen(assigned, "writer", "run-1:1")).toBe(0);
    completeWarmReleasedScreen(assigned, "writer", 0, 100);

    expect(nextScreenIndex(assigned, "writer", "run-1:1", 1)).toBe(0);
    expect(assigned.get("writer")?.idleAt).toBe(100);
    expect(oldestIdleScreen(assigned, 1)).toBe("writer");

    expect(nextScreenIndex(assigned, "writer", "run-2:2", 1)).toBe(0);
    expect(assigned.get("writer")?.idleAt).toBeUndefined();
    expect(oldestIdleScreen(assigned, 1)).toBeUndefined();
  });

  it("releases a retained screen after the same run resumes", () => {
    const assigned = new Map<string, ScreenAssignment>();
    expect(nextScreenIndex(assigned, "writer", "run-1:1")).toBe(0);
    expect(releaseAssignedScreen(assigned, "writer", "run-1:8")).toBe(0);
    completeReleasedScreen(assigned, "writer", 0);
    expect(nextScreenIndex(assigned, "researcher")).toBe(0);
  });

  it("does not let a delayed request restore an older lease", () => {
    const assigned = new Map<string, ScreenAssignment>();
    expect(nextScreenIndex(assigned, "writer", "run-2:2")).toBe(0);
    expect(() => nextScreenIndex(assigned, "writer", "run-1:1")).toThrow(
      /owned by a newer execution/,
    );
    expect(releaseAssignedScreen(assigned, "writer", "run-1:1")).toBeUndefined();
    expect(releaseAssignedScreen(assigned, "writer", "run-2:2")).toBe(0);
  });

  it("does not let a closing viewer release a screen claimed by a run", () => {
    const assigned = new Map<string, ScreenAssignment>();
    expect(nextScreenIndex(assigned, "writer", "screen-view-writer:0")).toBe(0);
    expect(nextScreenIndex(assigned, "writer", "run-1:1")).toBe(0);
    expect(releaseAssignedScreen(assigned, "writer", "screen-view-writer:0")).toBeUndefined();
    expect(releaseAssignedScreen(assigned, "writer", "run-1:1")).toBe(0);
  });

  it("stops the released bot's browser without tearing down the primary desktop", () => {
    const primary = stopExtraScreenCommand(0, "writer");
    expect(primary).toContain(`--user-data-dir=${browserProfilePathForScreen("writer")}`);
    expect(primary).toContain("kill -KILL");
    expect(primary).not.toMatch(/Xvfb :1 /);
    expect(primary).not.toContain("websockify");
    expect(primary).toContain("sockets/view-1-");
    expect(primary).toContain("sockets/control-1-");
    expect(primary).toContain("rm -f /tmp/rakazo/control-token-1");
    expect(primary).toContain("transport failed to stop");

    const extra = stopExtraScreenCommand(1, "researcher");
    expect(extra).toContain("[X]vfb :2 -screen");
    expect(extra).toContain("[f]luxbox -rc /tmp/fluxbox-home-2/.fluxbox/init");
    expect(extra).toContain("sockets/view-2-");
    expect(extra).not.toContain("websockify");
    expect(extra).toContain(`--user-data-dir=${browserProfilePathForScreen("researcher")}`);
  });

  it.each([0, 1])("releases screen %i access without stopping its browser or display", (index) => {
    const stop = screenReleaseStopCommand(index, {
      hasRegistry: true,
      cancelRunWork: false,
      screenId: "writer",
    });
    expect(stop).toContain(`sockets/view-${index + 1}-`);
    expect(stop).toContain(`sockets/control-${index + 1}-`);
    expect(stop).toContain(`rm -f /tmp/rakazo/control-token-${index + 1}`);
    expect(stop).not.toContain("--user-data-dir");
    expect(stop).not.toContain("browser-profile-");
    expect(stop).not.toContain("browser-launch-");
    expect(stop).not.toContain("Xvfb");
    expect(stop).not.toContain("fluxbox");
    expect(stop).not.toContain("websockify");
  });

  it("retains the browser slot and fence across run and idle viewer releases", async () => {
    const assigned = new Map<string, ScreenAssignment>();
    nextScreenIndex(assigned, "researcher", "other-run:1");
    expect(nextScreenIndex(assigned, "writer", "run-1:2")).toBe(1);
    assigned.get("writer")!.viewToken = "old-view-token";
    assigned.get("writer")!.controlled = true;
    assigned.get("writer")!.controlToken = "old-control-token";
    expect(releaseAssignedScreen(assigned, "writer", "run-1:2")).toBe(1);
    await teardownReleasedScreen(assigned, "writer", 1, async () => ({ code: 0, stderr: "" }), {
      retainBrowser: true,
    });

    expect(assigned.get("writer")).toEqual({
      index: 1,
      leaseId: "run-1:2",
      idleAt: expect.any(Number),
    });
    expect(oldestIdleScreen(assigned, 2)).toBe("writer");
    expect(nextScreenIndex(assigned, "new-bot", "new-run:3")).toBe(2);
    expect(() => nextScreenIndex(assigned, "writer", "screen-view-writer:0")).toThrow(
      /owned by a newer execution/,
    );
    expect(releaseAssignedScreen(assigned, "writer", "screen-view-writer:0")).toBeUndefined();
    expect(nextScreenIndex(assigned, "writer", "run-2:4")).toBe(1);
    expect(releaseAssignedScreen(assigned, "writer", "run-1:2")).toBeUndefined();
    expect(releaseAssignedScreen(assigned, "writer", "run-2:4")).toBe(1);
    await teardownReleasedScreen(assigned, "writer", 1, async () => ({ code: 0, stderr: "" }), {
      retainBrowser: true,
    });
    expect(assigned.get("researcher")).toEqual({ index: 0, leaseId: "other-run:1" });

    const idle = new Map<string, ScreenAssignment>();
    nextScreenIndex(idle, "writer", "screen-view-writer:0");
    expect(releaseAssignedScreen(idle, "writer", "screen-view-writer:0")).toBe(0);
    await teardownReleasedScreen(idle, "writer", 0, async () => ({ code: 0, stderr: "" }), {
      retainBrowser: true,
    });
    expect(nextScreenIndex(idle, "writer", "run-3:5")).toBe(0);
  });

  it("on cancel, stops only the matching bot's primary-display Chromium", () => {
    const stop = screenReleaseStopCommand(0, {
      hasRegistry: true,
      cancelRunWork: true,
      screenId: "writer",
    });
    expect(stop).toContain(`--user-data-dir=${browserProfilePathForScreen("writer")}`);
    expect(stop).not.toContain(`--user-data-dir=${browserProfilePathForScreen("researcher")}`);
    expect(stop).not.toContain("Xvfb");
    expect(stop).not.toContain("fluxbox");
  });

  it("does not stop the primary browser when a present registry rejects release", () => {
    expect(
      screenReleaseStopCommand(undefined, {
        hasRegistry: true,
        cancelRunWork: true,
        screenId: "writer",
      }),
    ).toBe("");
  });

  it("still stops the matching bot browser on cancel when the screen registry is missing", () => {
    // After a supervisor restart, in-memory assignments are gone; cancel must still
    // tear down the bot's orphaned Chromium without falling back on a rejected lease.
    const orphanCancelStop = screenReleaseStopCommand(undefined, {
      hasRegistry: false,
      cancelRunWork: true,
      screenId: "writer",
    });
    expect(orphanCancelStop).toContain(`--user-data-dir=${browserProfilePathForScreen("writer")}`);
    expect(orphanCancelStop).not.toContain("Xvfb");
  });

  it("parses a captured frame without trusting optional desktop metadata", () => {
    expect(
      parseObservation(
        [
          "GEOM 1280 800",
          "CURSOR X=12 Y=34 SCREEN=0 WINDOW=99",
          "WINDOW 99",
          "TITLE Browser",
          "IMAGE AQID",
        ].join("\n"),
      ),
    ).toEqual({
      image: "AQID",
      mimeType: "image/png",
      width: 1280,
      height: 800,
      cursor: { x: 12, y: 34 },
      activeWindow: { id: "99", title: "Browser" },
    });
    expect(() => parseObservation("GEOM 1280 800\nIMAGE ")).toThrow(/no image/);
  });
});

describe("docker exec stream demux", () => {
  const frame = (type: number, text: string | Buffer) => {
    const payload = typeof text === "string" ? Buffer.from(text, "utf8") : text;
    const header = Buffer.alloc(8);
    header[0] = type;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };

  it("keeps stderr frames out of stdout", () => {
    const stream = Buffer.concat([
      frame(1, "aGVsbG8="),
      frame(2, "python: DeprecationWarning\n"),
      frame(1, "\n"),
    ]);
    expect(demuxDockerStream(stream)).toEqual({
      stdout: "aGVsbG8=\n",
      stderr: "python: DeprecationWarning\n",
    });
  });

  it("treats a raw tty stream as stdout", () => {
    expect(demuxDockerStream(Buffer.from("plain output\n"))).toEqual({
      stdout: "plain output\n",
      stderr: "",
    });
    expect(demuxDockerStream(Buffer.alloc(0))).toEqual({ stdout: "", stderr: "" });
  });

  it("falls back to raw stdout when the stream is not a complete multiplexed sequence", () => {
    const cut = Buffer.concat([frame(1, "kept"), frame(2, "truncated stderr")]).subarray(
      0,
      12 + 8 + 6,
    );
    expect(demuxDockerStream(cut)).toEqual({ stdout: cut.toString("utf8"), stderr: "" });
    const dangling = Buffer.concat([frame(1, "ok"), Buffer.from([1, 0, 0])]);
    expect(demuxDockerStream(dangling)).toEqual({
      stdout: dangling.toString("utf8"),
      stderr: "",
    });
  });

  it("treats raw payloads that begin with 0x01 or 0x02 as stdout when not valid frames", () => {
    // size 0xffffffff does not fit remaining bytes → not a complete multiplexed stream
    const raw01 = Buffer.from([0x01, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x41, 0x42]);
    expect(demuxDockerStream(raw01)).toEqual({
      stdout: raw01.toString("utf8"),
      stderr: "",
    });
    const raw02 = Buffer.from([0x02, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x43, 0x44]);
    expect(demuxDockerStream(raw02)).toEqual({
      stdout: raw02.toString("utf8"),
      stderr: "",
    });
  });

  it("emits complete frames before the stream ends", () => {
    const stream = Buffer.concat([
      frame(1, "code: ABCD-1234\n"),
      frame(2, "waiting\n"),
      frame(1, "done\n"),
    ]);
    const demuxer = createDockerStreamDemuxer();
    const live: Array<{ stream: string; data: string }> = [];
    const splitAt = 8 + Buffer.byteLength("code: ABCD-1234\n") + 3;
    live.push(...demuxer.push(stream.subarray(0, splitAt)));
    expect(live).toEqual([{ stream: "stdout", data: "code: ABCD-1234\n" }]);
    live.push(...demuxer.push(stream.subarray(splitAt)));
    live.push(...demuxer.finish());
    expect(live).toEqual([
      { stream: "stdout", data: "code: ABCD-1234\n" },
      { stream: "stderr", data: "waiting\n" },
      { stream: "stdout", data: "done\n" },
    ]);
    expect(demuxDockerStream(stream)).toEqual({
      stdout: "code: ABCD-1234\ndone\n",
      stderr: "waiting\n",
    });
  });

  it("keeps UTF-8 characters split across frames and chunks intact", () => {
    const stderr = Buffer.from("😀é\n");
    const multiplexed = Buffer.concat([
      ...[...Buffer.from("é😀\n")].flatMap((byte, i) => [
        frame(1, Buffer.from([byte])),
        frame(2, stderr.subarray(i, i + 1)),
      ]),
      frame(2, Buffer.from([0xf0])),
      frame(1, Buffer.from([0xe2])),
      frame(2, Buffer.from([0x9f])),
      frame(1, Buffer.from([0x82])),
    ]);
    const cases = [
      [multiplexed, { stdout: "é😀\n\ufffd", stderr: "😀é\n\ufffd" }],
      [
        Buffer.concat([Buffer.from("raw é😀\n"), Buffer.from([0xe2, 0x82])]),
        { stdout: "raw é😀\n\ufffd", stderr: "" },
      ],
      [Buffer.from([0x61, 0xc3]), { stdout: "a\ufffd", stderr: "" }],
    ] as const;
    for (const [bytes, expected] of cases) {
      const demuxer = createDockerStreamDemuxer();
      const live = [...bytes].flatMap((byte) => demuxer.push(Buffer.from([byte])));
      live.push(...demuxer.finish());
      const streamed = { stdout: "", stderr: "" };
      for (const piece of live) streamed[piece.stream] += piece.data;
      expect(streamed).toEqual(expected);
      expect(demuxDockerStream(bytes)).toEqual(expected);
    }
  });

  it("rejects frames with nonzero reserved header padding as raw stdout", () => {
    // type 1, nonzero padding, size 0 — would look like an empty stdout frame without the check
    const padded = Buffer.from([0x01, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00]);
    expect(demuxDockerStream(padded)).toEqual({
      stdout: padded.toString("utf8"),
      stderr: "",
    });
  });
});

describe("computer command identity", () => {
  it("gives commands the workspace user's home, PATH and package prefixes on the screen's display", () => {
    expect(computerCommandEnv({ display: ":2" })).toEqual([
      "DISPLAY=:2",
      "HOME=/home/rakazo",
      "PATH=/home/rakazo/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "NPM_CONFIG_PREFIX=/home/rakazo/.local",
      "PIP_USER=1",
    ]);
  });
});

describe("computer name recovery", () => {
  const conflict = Object.assign(new Error("container name already in use"), { statusCode: 409 });
  function holder(labels: Record<string, string>, image = "computer") {
    return {
      Id: "leftover",
      Config: { Labels: labels, Image: image },
    } as Docker.ContainerInspectInfo;
  }
  const owned = { "rakazo.botId": "bot", "rakazo.spaceId": "space", "rakazo.managed": "true" };
  function recovery(info: Docker.ContainerInspectInfo) {
    const remove = vi.fn().mockResolvedValue(undefined);
    const cleared = vi.fn();
    const inspect = vi.fn().mockResolvedValue(info);
    const reclaim = () =>
      removeOwnedComputer(
        { inspect } as Pick<Docker.Container, "inspect">,
        remove,
        (candidate) => isManagedComputer(candidate, "bot", "space", "computer"),
        cleared,
      );
    return { remove, cleared, inspect, reclaim };
  }

  it("clears an owned leftover by inspected ID and retries create once", async () => {
    const { reclaim, remove, cleared } = recovery(holder(owned));
    const created = { id: "new" };
    const create = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValue(created);
    await expect(createComputerWithNameRetry(create, reclaim)).resolves.toBe(created);
    expect(create).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledExactlyOnceWith("leftover");
    expect(cleared).toHaveBeenCalledExactlyOnceWith("leftover");
  });

  it.each([
    { ...owned, "rakazo.botId": "other" },
    { ...owned, "rakazo.spaceId": "other" },
    {} as Record<string, string>,
    { "rakazo.botId": "bot", "rakazo.spaceId": "space" },
  ])("preserves a non-owned name holder and the original error: %j", async (labels) => {
    const { reclaim, remove, cleared } = recovery(holder(labels, "unmanaged"));
    const create = vi.fn().mockRejectedValue(conflict);
    await expect(createComputerWithNameRetry(create, reclaim)).rejects.toBe(conflict);
    expect(create).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect(cleared).not.toHaveBeenCalled();
  });

  it("accepts the existing legacy identity and image management rule", () => {
    expect(
      isManagedComputer(
        holder({ "rakazo.botId": "bot", "rakazo.workspaceId": "space" }),
        "bot",
        "space",
        "computer",
      ),
    ).toBe(true);
  });

  it("preserves the original error when inspection or removal fails", async () => {
    for (const stage of ["inspect", "remove"] as const) {
      const recoveryAttempt = recovery(holder(owned));
      recoveryAttempt[stage].mockRejectedValue(new Error("unavailable"));
      await expect(
        createComputerWithNameRetry(async () => {
          throw conflict;
        }, recoveryAttempt.reclaim),
      ).rejects.toBe(conflict);
      expect(recoveryAttempt.cleared).not.toHaveBeenCalled();
    }
  });

  it("does not retry a second create conflict", async () => {
    const create = vi.fn().mockRejectedValue(conflict);
    const reclaim = vi.fn().mockResolvedValue(true);
    await expect(createComputerWithNameRetry(create, reclaim)).rejects.toBe(conflict);
    expect(create).toHaveBeenCalledTimes(2);
    expect(reclaim).toHaveBeenCalledTimes(1);
  });

  it.each([409, 500])("does not retry a start failure (status %s)", async (statusCode) => {
    const error = Object.assign(new Error("address already in use"), { statusCode });
    const start = vi.fn().mockRejectedValue(error);
    const create = vi.fn(async () => ({ start }));
    const reclaim = vi.fn();
    await expect(
      (async () => {
        const container = await createComputerWithNameRetry(create, reclaim);
        await container.start();
      })(),
    ).rejects.toBe(error);
    expect(create).toHaveBeenCalledTimes(1);
    expect(reclaim).not.toHaveBeenCalled();
  });
});
