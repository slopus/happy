import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as TimersPromises from "node:timers/promises";
import { promisify } from "node:util";
import type { ComputerRef, PortableFile, ProcessEvent } from "@rakazo/adapter-kit";
import {
  browserProfilePathForScreen,
  DEFAULT_DESKTOP_ENV,
} from "@rakazo/core/node/desktop-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHROME_OWNS_DEBUG_PORT_SCRIPT,
  CREATEOS_SCREEN_MAP_SCRIPT,
  CREATEOS_SCREEN_MAP_SENTINEL,
  CreateOSHttpError,
  CreateOSSandboxProvider,
  isAllowedCreateOSScreenUrl,
  MAX_CREATEOS_ERROR_RESPONSE_BYTES,
  MAX_CREATEOS_SUCCESS_RESPONSE_BYTES,
} from "./createos-sandbox.js";
import { isSandboxGoneError } from "./sandbox-errors.js";

// Status polls wait a second between reads; the fakes below settle on the next read.
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof TimersPromises>()),
  setTimeout: async <T>(_ms?: number, value?: T, options?: { signal?: AbortSignal }) => {
    options?.signal?.throwIfAborted();
    return value as T;
  },
}));

const execFileAsync = promisify(execFile);

const context = {
  operationId: "test",
  traceId: "trace",
  workspaceId: "workspace",
  spaceId: "workspace",
  userId: "user",
  botId: "bot-a",
  signal: new AbortController().signal,
};

const WORKSPACE_LISTING = JSON.stringify([
  { name: "notes.txt", kind: "file", size: 5, executable: false },
]);

interface ExecCall {
  path: string;
  command: string;
  stdin?: string;
}

/**
 * The JSend envelopes and sandbox statuses of the CreateOS control plane, as published in
 * @nodeops-createos/sandbox 0.8.2 (types.d.ts). The SDK is not a dependency.
 */
type SandboxStatus =
  | "creating"
  | "running"
  | "pausing"
  | "paused"
  | "resuming"
  | "forking"
  | "error"
  | "destroying"
  | "destroyed"
  | "failed";
interface SuccessEnvelope<T> {
  status: "success";
  data: T;
}
interface FailEnvelope {
  status: "fail";
  data: Record<string, unknown> | string;
}
interface ErrorEnvelope {
  status: "error";
  message: string;
  code: number;
}

function jsonResponse(data: unknown): Response {
  return new Response(
    JSON.stringify({ status: "success", data } satisfies SuccessEnvelope<unknown>),
    {
      headers: { "content-type": "application/json" },
    },
  );
}

function failResponse(status: number, code: string, error: string): Response {
  return new Response(
    JSON.stringify({ status: "fail", data: { code, error } } satisfies FailEnvelope),
    { status, headers: { "content-type": "application/json" } },
  );
}

function errorResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ status: "error", message, code: status } satisfies ErrorEnvelope),
    { status, headers: { "content-type": "application/json" } },
  );
}

function shellArgs(command: string): string[] {
  const args: string[] = [];
  for (const match of command.matchAll(/'([^']*)'/g)) args.push(match[1] ?? "");
  return args;
}

/** Inverse of shellQuote, including the '"'"' encoding of an embedded single quote. */
function unshellQuote(quoted: string): string {
  let value = "";
  let index = 1;
  while (index < quoted.length) {
    if (quoted.startsWith(`'"'"'`, index)) {
      value += "'";
      index += `'"'"'`.length;
      continue;
    }
    if (quoted[index] === "'") return value;
    value += quoted[index];
    index += 1;
  }
  throw new Error("unterminated shell quote");
}

/** Route-driven CreateOS control-plane double. Exec replies are keyed off the shell command. */
function createosFixture(
  options: {
    statuses?: string[];
    connectionUrl?: string;
    failScreenDeletes?: number;
    annotateScreen?: boolean;
    failConnectScreenIds?: string[];
    holdConnect?: { screenId: string; hit: number; gate: Promise<void>; onHold: () => void };
  } = {},
) {
  const statuses = [...(options.statuses ?? ["running"])];
  const calls: string[] = [];
  const bodies: Array<{ route: string; body: unknown }> = [];
  const execs: ExecCall[] = [];
  const events: string[] = [];
  const failConnects = new Set(options.failConnectScreenIds ?? []);
  const connectHits = new Map<string, number>();
  let heldConnect = false;
  const screenMapPath = path.join(
    mkdtempSync(path.join(tmpdir(), "createos-screens-")),
    "screens.json",
  );
  let nextScreen = 1;
  let screenDeleteFailures = options.failScreenDeletes ?? 0;
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const route = `${method} ${url.pathname}`;
    calls.push(route);
    if (typeof init?.body === "string") bodies.push({ route, body: JSON.parse(init.body) });

    if (route === "POST /v1/sandboxes") {
      return jsonResponse({ id: "sbx-1", status: statuses[0] ?? "running" });
    }
    if (method === "GET" && /^\/v1\/sandboxes\/[^/]+$/.test(url.pathname)) {
      return jsonResponse({ id: "sbx-1", status: statuses.shift() ?? "running" });
    }
    if (method === "POST" && url.pathname.endsWith("/exec")) {
      const body = JSON.parse(String(init?.body)) as { args: string[]; stdin?: string };
      const command = body.args[3] ?? "";
      execs.push({ path: url.pathname, command, stdin: body.stdin });
      // The tab probe also lists /proc, so match it before the workspace listing.
      if (command.includes("/json/new")) {
        return jsonResponse({ result: { stdout: "", exit_code: 1 } });
      }
      if (command.includes(CREATEOS_SCREEN_MAP_SENTINEL)) {
        const args = shellArgs(command);
        const at = args.indexOf(CREATEOS_SCREEN_MAP_SENTINEL);
        const stdout = execFileSync(
          "python3",
          [
            "-c",
            args[at - 1] ?? "",
            args[at] ?? "",
            args[at + 1] ?? "",
            args[at + 2] ?? "",
            args[at + 3] ?? "",
            screenMapPath,
          ],
          { encoding: "utf8" },
        );
        return jsonResponse({ result: { stdout, exit_code: 0 } });
      }
      if (command.includes("os.listdir")) {
        return jsonResponse({ result: { stdout: WORKSPACE_LISTING, exit_code: 0 } });
      }
      return jsonResponse({ result: { stdout: "hello\n", exit_code: 0 } });
    }
    if (method === "POST" && url.pathname.endsWith("/computer/screens")) {
      const screenId = `screen-${nextScreen}`;
      nextScreen += 1;
      return jsonResponse({ screen_id: screenId });
    }
    if (method === "DELETE" && /\/computer\/screens\/[^/]+$/.test(url.pathname)) {
      events.push(`delete:${url.pathname.split("/").at(-1) ?? ""}`);
      if (screenDeleteFailures > 0) {
        screenDeleteFailures -= 1;
        return errorResponse(500, "unavailable");
      }
    }
    if (method === "GET" && url.pathname.endsWith("/connect")) {
      const screenId = url.pathname.split("/").at(-2) ?? "";
      const hit = (connectHits.get(screenId) ?? 0) + 1;
      connectHits.set(screenId, hit);
      const hold = options.holdConnect;
      if (hold && !heldConnect && screenId === hold.screenId && hit === hold.hit) {
        heldConnect = true;
        hold.onHold();
        await hold.gate;
        events.push(`resume:${screenId}`);
      }
      if (failConnects.has(screenId)) {
        return failResponse(404, "screen_not_found", "screen not found");
      }
      if (!options.connectionUrl) return jsonResponse({});
      if (!options.annotateScreen) return jsonResponse({ url: options.connectionUrl, token: "t" });
      const annotated = new URL(options.connectionUrl, "https://api.sb.createos.sh");
      annotated.searchParams.set("screen", screenId);
      return jsonResponse({ url: annotated.toString(), token: "t" });
    }
    if (method === "GET" && url.pathname.endsWith("/files")) {
      return new Response(new TextEncoder().encode("notes"));
    }
    return jsonResponse({});
  }) as typeof fetch;

  return { calls, bodies, execs, events, fetchImpl };
}

function provider(fixture: ReturnType<typeof createosFixture>) {
  return new CreateOSSandboxProvider({ apiKey: "test-key", fetch: fixture.fetchImpl });
}

const computer: ComputerRef = {
  id: "sbx-1",
  botId: "bot-a",
  kind: "createos",
  providerRef: "sbx-1",
  fresh: true,
};

function createosBotProfile(botId: string) {
  return browserProfilePathForScreen(botId, {
    ...DEFAULT_DESKTOP_ENV,
    browserProfilesDir: "/home/desktop/rakazo-home/.browser-profiles",
  });
}

describe("CreateOSSandboxProvider", () => {
  it("creates a sandbox and waits until it runs", async () => {
    const fixture = createosFixture({ statuses: ["creating", "running"] });
    const ref = await provider(fixture).provision({ botId: "bot-a", homePath: "/unused" }, context);

    expect(ref).toMatchObject({ id: "sbx-1", providerRef: "sbx-1", kind: "createos", fresh: true });
    expect(fixture.calls.filter((call) => call === "GET /v1/sandboxes/sbx-1").length).toBe(2);
  });

  it("resumes a paused sandbox and waits for it", async () => {
    const fixture = createosFixture({ statuses: ["paused", "running"] });
    const ref = await provider(fixture).provision(
      { botId: "bot-a", homePath: "/unused", providerRef: "sbx-1", providerKind: "createos" },
      context,
    );

    expect(ref.fresh).toBe(false);
    expect(fixture.calls).toContain("POST /v1/sandboxes/sbx-1/resume");
    expect(fixture.calls).not.toContain("POST /v1/sandboxes");
  });

  it("lets a pausing sandbox settle before it resumes", async () => {
    const fixture = createosFixture({ statuses: ["pausing", "pausing", "paused", "running"] });
    const ref = await provider(fixture).provision(
      { botId: "bot-a", homePath: "/unused", providerRef: "sbx-1", providerKind: "createos" },
      context,
    );

    expect(ref.fresh).toBe(false);
    expect(fixture.calls).toContain("POST /v1/sandboxes/sbx-1/resume");
    expect(fixture.calls).not.toContain("POST /v1/sandboxes");
  });

  it("waits for an existing sandbox that is neither running nor paused", async () => {
    const fixture = createosFixture({ statuses: ["creating", "running"] });
    await provider(fixture).provision(
      { botId: "bot-a", homePath: "/unused", providerRef: "sbx-1", providerKind: "createos" },
      context,
    );

    expect(fixture.calls).not.toContain("POST /v1/sandboxes/sbx-1/resume");
    expect(fixture.calls.filter((call) => call === "GET /v1/sandboxes/sbx-1").length).toBe(2);
  });

  it("runs commands inside the workspace with the requested environment", async () => {
    const fixture = createosFixture();
    const events = [];
    for await (const event of provider(fixture).execute(
      computer,
      { argv: ["echo", "hello"], cwd: "notes", env: { TEST_VALUE: "works" }, unsetEnv: ["FAILED"] },
      context,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "stdout", data: "hello\n" },
      { type: "exit", code: 0 },
    ]);
    const exec = fixture.execs.at(-1);
    expect(exec?.command).toBe(
      `mkdir -p '/home/desktop/rakazo-home/notes' && cd '/home/desktop/rakazo-home/notes' && eval "$(cat)" && 'env' '-u' 'FAILED' '--' 'echo' 'hello'`,
    );
    expect(exec?.stdin).toBe("export TEST_VALUE='works'\n");
  });

  it("sends command secrets on stdin, never in command text", async () => {
    const fixture = createosFixture();
    const secret = "fake-secret-'value'";
    for await (const _ of provider(fixture).execute(
      computer,
      { argv: ["printenv", "FAKE_TOKEN"], env: { FAKE_TOKEN: secret } },
      context,
    ));
    for await (const _ of provider(fixture).execute(computer, { argv: ["true"] }, context));

    expect(fixture.execs.some((exec) => exec.command.includes("fake-secret"))).toBe(false);
    expect(fixture.execs.at(-2)?.stdin).toContain("fake-secret");
    expect(fixture.execs.at(-1)).toMatchObject({ stdin: undefined });
    expect(fixture.execs.at(-1)?.command).not.toContain("cat");

    const invalid = async () => {
      for await (const _ of provider(fixture).execute(
        computer,
        { argv: ["true"], env: { "BAD NAME": "fake-secret" } },
        context,
      ));
    };
    const execs = fixture.execs.length;
    await expect(invalid()).rejects.toThrow("invalid environment variable name");
    expect(fixture.execs.length).toBe(execs);
  });

  it("reports a timed-out command as exit code 124", async () => {
    const fetchImpl = (async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    const events = [];
    for await (const event of new CreateOSSandboxProvider({
      apiKey: "test-key",
      fetch: fetchImpl,
    }).execute(computer, { argv: ["sleep", "600"] }, context)) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({ type: "exit", code: 124 });
    expect(events[0]).toMatchObject({ type: "stderr" });
  });

  it.each(["run-1", "stop", "computer.sleep"])(
    "quiesces Chromium before exporting a %s checkpoint",
    async (operationId) => {
      const fixture = createosFixture();
      const files: PortableFile[] = [];
      for await (const file of provider(fixture).exportWorkspace(computer, {
        ...context,
        operationId,
      })) {
        files.push(file);
      }

      expect(files.map((file) => file.path)).toEqual(["notes.txt"]);
      const quiesceIndex = fixture.execs.findIndex(
        (exec) =>
          exec.command.includes("Browser.close") &&
          exec.command.includes("chromium-bot-*") &&
          exec.command.includes(".browser-profiles'\"'\"'/chromium ") &&
          exec.command.includes("/chromium-screen-*"),
      );
      expect(quiesceIndex).toBeGreaterThanOrEqual(0);
      const listings = fixture.execs.flatMap((exec, index) =>
        exec.command.includes("os.listdir") ? [index] : [],
      );
      expect(quiesceIndex).toBeGreaterThan(listings[0] ?? -1);
      expect(quiesceIndex).toBeLessThan(listings[1] ?? -1);
    },
  );

  it("launches and links each bot to the Chromium profile hard delete removes", async () => {
    const fixture = createosFixture();
    const target = provider(fixture);
    await target.prepare(computer, context);
    await target.act(
      computer,
      {
        actions: [{ kind: "launch", application: "google-chrome", uri: "https://example.test" }],
        observe: false,
      },
      context,
    );
    await target.act(
      computer,
      {
        actions: [{ kind: "launch", application: "google-chrome", uri: "https://example.test" }],
        observe: false,
      },
      { ...context, botId: "bot-b" },
    );

    const profileA = createosBotProfile("bot-a");
    const profileB = createosBotProfile("bot-b");
    expect(profileA).toMatch(/\/chromium-bot-[0-9a-f]{32}$/);
    expect(profileB).not.toBe(profileA);
    const commands = fixture.execs.map((exec) => exec.command);
    expect(
      commands.some((command) => command.includes(`ln -sfn`) && command.includes(profileA)),
    ).toBe(true);
    const launches = commands.filter(
      (command) => command.includes("google-chrome") && command.includes("--user-data-dir="),
    );
    expect(launches.some((command) => command.includes(profileA))).toBe(true);
    expect(launches.some((command) => command.includes(profileB))).toBe(true);
    for (const command of launches) {
      expect(command).not.toContain("pgrep -u desktop");
      expect(command).toContain("--no-first-run");
      expect(command).toContain("--remote-debugging-port=$debug_port");
      expect(command).not.toContain("--remote-debugging-port=9222");
      expect(command).toContain('flag = "--user-data-dir=" + profile');
      expect(command).toContain('while [ "$attempt" -lt 2 ]');
      expect(command).toContain("signal.SIGTERM");
      const quoted = command.slice(command.lastIndexOf("'-lc' ") + "'-lc' ".length);
      execFileSync("bash", ["-n", "-c", unshellQuote(quoted)]);
    }
    for (const command of commands) {
      expect(command).not.toContain("/.browser-profiles/chromium'");
    }
  });

  it("accepts a debugger port only when this profile's browser owns the socket", () => {
    const root = mkdtempSync(path.join(tmpdir(), "chrome-proc-"));
    const profile = "/tmp/bot-profile";
    const pid = path.join(root, "4242");
    const port = 9333;
    mkdirSync(path.join(pid, "fd"), { recursive: true });
    mkdirSync(path.join(root, "net"), { recursive: true });
    const cmdline = [
      "google-chrome",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "",
    ].join("\0");
    writeFileSync(path.join(pid, "cmdline"), cmdline);
    writeFileSync(
      path.join(root, "net", "tcp"),
      `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:${port.toString(16).toUpperCase()} 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 99 1 0000000000000000 100 0 0 10 0\n`,
    );
    const socket = path.join(pid, "fd", "3");
    symlinkSync("socket:[99]", socket);
    const probe = (args: string[]) =>
      execFileSync("python3", ["-c", CHROME_OWNS_DEBUG_PORT_SCRIPT, ...args], { encoding: "utf8" });

    expect(() => probe([profile, String(port), root])).not.toThrow();
    expect(() => probe([profile, "", root])).not.toThrow();
    expect(() => probe([profile, "9444", root])).toThrow();
    unlinkSync(socket);
    symlinkSync("socket:[100]", socket);
    expect(() => probe([profile, String(port), root])).toThrow();
  });

  it("moves the pointer to a scroll's point before turning the wheel", async () => {
    const fixture = createosFixture();
    const target = provider(fixture);
    await target.act(
      computer,
      {
        actions: [{ kind: "scroll", direction: "down", amount: 4, x: 600, y: 420 }],
        observe: false,
      },
      context,
    );
    const mouse = fixture.bodies.filter(({ route }) => route.includes("/computer/mouse/"));
    expect(mouse).toEqual([
      { route: expect.stringMatching(/\/mouse\/move$/), body: { x: 600, y: 420 } },
      {
        route: expect.stringMatching(/\/mouse\/scroll$/),
        body: { direction: "down", amount: 4 },
      },
    ]);
  });

  it("caps a scroll at twenty notches and refuses sideways scrolling it can't do", async () => {
    const fixture = createosFixture();
    const target = provider(fixture);
    await target.act(
      computer,
      { actions: [{ kind: "scroll", direction: "down", amount: 50 }], observe: false },
      context,
    );
    expect(fixture.bodies.find(({ route }) => route.endsWith("/mouse/scroll"))?.body).toEqual({
      direction: "down",
      amount: 20,
    });
    await expect(
      target.act(
        computer,
        { actions: [{ kind: "scroll", direction: "left", amount: 2 }], observe: false },
        context,
      ),
    ).rejects.toThrow("CreateOS computers can only scroll up or down");
  });

  it("scrolls where the pointer is when a scroll has no point", async () => {
    const fixture = createosFixture();
    const target = provider(fixture);
    await target.act(
      computer,
      { actions: [{ kind: "scroll", direction: "up" }], observe: false },
      context,
    );
    expect(fixture.calls.some((route) => route.endsWith("/mouse/move"))).toBe(false);
    expect(fixture.calls.some((route) => route.endsWith("/mouse/scroll"))).toBe(true);
  });

  it("exports the workspace after a graphical action alone", async () => {
    const fixture = createosFixture();
    const target = provider(fixture);
    await target.act(computer, { actions: [{ kind: "wait", ms: 0 }], observe: false }, context);

    const files: PortableFile[] = [];
    for await (const file of target.exportWorkspace(computer, context)) files.push(file);

    expect(files.map((file) => file.path)).toEqual(["notes.txt"]);
    expect(fixture.execs.some((exec) => exec.command.includes("os.lstat"))).toBe(true);
    expect(fixture.execs.some((exec) => exec.command.includes("S_ISLNK"))).toBe(true);
  });

  it("exports a resumed sandbox after the provider process restarts", async () => {
    const fixture = createosFixture();
    await provider(fixture).execute(computer, { argv: ["echo", "hi"] }, context);

    const files: PortableFile[] = [];
    for await (const file of provider(fixture).exportWorkspace(computer, context)) files.push(file);

    expect(files.map((file) => file.path)).toEqual(["notes.txt"]);
  });

  it("forgets per-sandbox state on stop and destroy", async () => {
    const fixture = createosFixture();
    const target = provider(fixture);
    await target.act(computer, { actions: [{ kind: "wait", ms: 0 }], observe: false }, context);
    await target.stop(computer, context);

    const afterStop: PortableFile[] = [];
    for await (const file of target.exportWorkspace(computer, context)) afterStop.push(file);
    expect(afterStop.map((file) => file.path)).toEqual(["notes.txt"]);

    await target.destroy(computer, context);
    expect(fixture.calls).toContain("DELETE /v1/sandboxes/sbx-1");
  });

  it("releases a control lease so expiry and demotion can finish", async () => {
    const fixture = createosFixture();
    const target = provider(fixture);

    await expect(
      target.setScreenControl(computer, false, context, "lease-1"),
    ).resolves.toBeUndefined();
    await expect(target.setScreenControl(computer, true, context)).rejects.toThrow(
      /interactive screen requires a control token/,
    );
    await expect(target.setScreenControl(computer, true, context, "lease-1")).rejects.toThrow(
      /CreateOS screen control changes are unsupported/,
    );
    await expect(target.setScreenControl(computer, false, context)).resolves.toBeUndefined();
    expect(fixture.calls).toEqual([]);
  });

  it("treats teardown of a missing sandbox as done", async () => {
    const gone = (async () => failResponse(404, "not_found", "sandbox not found")) as typeof fetch;
    const target = new CreateOSSandboxProvider({ apiKey: "test-key", fetch: gone });

    await expect(target.stop(computer, context)).resolves.toBeUndefined();
    await expect(target.destroy(computer, context)).resolves.toBeUndefined();
  });

  it("reports a cancelled command as an abort", async () => {
    const controller = new AbortController();
    const fixture = createosFixture();
    const aborting = (async (input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input).endsWith("/exec")) {
        controller.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      return fixture.fetchImpl(input, init);
    }) as typeof fetch;
    const target = new CreateOSSandboxProvider({ apiKey: "test-key", fetch: aborting });

    const events: ProcessEvent[] = [];
    for await (const event of target.execute(
      computer,
      { argv: ["sleep", "30"] },
      { ...context, signal: controller.signal },
    )) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({ type: "exit", code: 130 });
  });

  it("fails a command that reports an error without an exit code", async () => {
    const failing = (async (input: URL | RequestInfo) => {
      if (String(input).endsWith("/exec")) {
        return new Response(
          JSON.stringify({ status: "success", data: { result: { error: "no such file" } } }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ status: "success", data: { id: "sbx-1", status: "running" } }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;
    const target = new CreateOSSandboxProvider({ apiKey: "test-key", fetch: failing });

    const events: ProcessEvent[] = [];
    for await (const event of target.execute(computer, { argv: ["cat", "missing"] }, context)) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({ type: "exit", code: 1 });
  });

  it("refuses a plaintext base url outside loopback", () => {
    expect(
      () => new CreateOSSandboxProvider({ apiKey: "test-key", baseUrl: "http://api.example.com" }),
    ).toThrow(/https/);
    expect(
      () => new CreateOSSandboxProvider({ apiKey: "test-key", baseUrl: "http://127.0.0.1:8080" }),
    ).not.toThrow();
  });

  it("rejects a declared oversized success response without buffering it", async () => {
    const cancel = vi.fn();
    const fetchImpl = (async () =>
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-length": String(MAX_CREATEOS_SUCCESS_RESPONSE_BYTES + 1) },
      })) as typeof fetch;

    await expect(
      new CreateOSSandboxProvider({ apiKey: "test-key", fetch: fetchImpl }).provision(
        { botId: "bot-a", homePath: "/unused" },
        context,
      ),
    ).rejects.toThrow(`CreateOS response exceeds ${MAX_CREATEOS_SUCCESS_RESPONSE_BYTES} bytes`);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("does not buffer an oversized error body", async () => {
    const cancel = vi.fn();
    const fetchImpl = (async () =>
      new Response(new ReadableStream({ cancel }), {
        status: 500,
        headers: { "content-length": String(MAX_CREATEOS_ERROR_RESPONSE_BYTES + 1) },
      })) as typeof fetch;

    await expect(
      new CreateOSSandboxProvider({ apiKey: "test-key", fetch: fetchImpl }).destroy(
        computer,
        context,
      ),
    ).rejects.toThrow(/500/);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("destroys a sandbox that never becomes running", async () => {
    const fixture = createosFixture({ statuses: ["failed"] });
    await expect(
      provider(fixture).provision({ botId: "bot-a", homePath: "/unused" }, context),
    ).rejects.toThrow(/failed/);
    expect(fixture.calls).toContain("DELETE /v1/sandboxes/sbx-1");
  });

  it("refreshes auto-pause with an exec when keepAlive has no caller context", async () => {
    const fixture = createosFixture();
    await provider(fixture).keepAlive(computer);
    expect(fixture.execs.some((exec) => exec.command.includes(" 'true'"))).toBe(true);
    expect(fixture.calls.some((call) => call.startsWith("GET /v1/sandboxes/"))).toBe(false);
  });

  it("rejects a screen URL outside the CreateOS host allowlist", async () => {
    const fixture = createosFixture({
      connectionUrl: "https://evil.example/vnc.html?token=secret",
    });
    await expect(
      provider(fixture).connectScreen(computer, { view: "stream" }, context),
    ).rejects.toThrow(/host is not allowed/);
  });

  it("accepts a relative screen path on the CreateOS base port", async () => {
    const fixture = createosFixture({ connectionUrl: "/vnc.html" });
    const session = await new CreateOSSandboxProvider({
      apiKey: "test-key",
      baseUrl: "https://sandbox.example.test:8443",
      fetch: fixture.fetchImpl,
    }).connectScreen(computer, { view: "stream" }, context);

    expect(session.url?.startsWith("https://sandbox.example.test:8443/")).toBe(true);
  });

  it("reuses one screen assignment across provider instances", async () => {
    const fixture = createosFixture({ connectionUrl: "/vnc.html" });
    const api = provider(fixture);
    const worker = new CreateOSSandboxProvider({ apiKey: "test-key", fetch: fixture.fetchImpl });
    const botA = { ...context, botId: "bot-a" };
    const botB = { ...context, botId: "bot-b" };

    const first = await api.connectScreen(computer, { view: "stream" }, botA);
    await worker.connectScreen(computer, { view: "stream" }, botA);
    expect(new URL(first.url ?? "").hostname).toBe("api.sb.createos.sh");
    expect(fixture.calls.filter((call) => call.endsWith("/computer/screens"))).toEqual([]);

    await worker.connectScreen(computer, { view: "stream" }, botB);
    expect(fixture.calls.filter((call) => call.endsWith("/computer/screens"))).toEqual([
      "POST /v1/sandboxes/sbx-1/computer/screens",
    ]);
  });

  it("replaces a screen whose connection is already gone", async () => {
    const fixture = createosFixture({
      connectionUrl: "https://sandbox.app.sb.createos.sh/vnc.html",
      annotateScreen: true,
      failConnectScreenIds: ["screen-1"],
    });
    const target = provider(fixture);
    const botA = { ...context, botId: "bot-a" };
    const botB = { ...context, botId: "bot-b" };

    await target.connectScreen(computer, { view: "stream" }, botA);
    const session = await target.connectScreen(computer, { view: "stream" }, botB);

    expect(new URL(session.url ?? "").searchParams.get("screen")).toBe("screen-2");
    expect(
      fixture.calls.filter((call) => call === "POST /v1/sandboxes/sbx-1/computer/screens"),
    ).toHaveLength(2);
  });

  it("deletes a screen only after its in-flight connection finishes", async () => {
    let openGate: () => void = () => undefined;
    const connectGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let markHeld: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      markHeld = resolve;
    });
    const fixture = createosFixture({
      connectionUrl: "https://sandbox.app.sb.createos.sh/vnc.html",
      annotateScreen: true,
      holdConnect: { screenId: "screen-1", hit: 2, gate: connectGate, onHold: () => markHeld() },
    });
    const target = provider(fixture);
    const botA = { ...context, botId: "bot-a" };
    const botB = { ...context, botId: "bot-b" };

    await target.connectScreen(computer, { view: "stream" }, botA);
    await target.connectScreen(computer, { view: "stream" }, botB);
    const reconnecting = target.connectScreen(computer, { view: "stream" }, botB);
    await held;
    const releasing = target.releaseScreen(computer, botB);
    await vi.waitFor(() => {
      expect(fixture.execs.some((exec) => exec.command.includes("begin-release"))).toBe(true);
    });
    expect(fixture.events.some((event) => event.startsWith("delete:"))).toBe(false);

    openGate();
    const session = await reconnecting;
    await releasing;

    expect(new URL(session.url ?? "").searchParams.get("screen")).toBe("screen-2");
    const resumeAt = fixture.events.indexOf("resume:screen-1");
    const deleteAt = fixture.events.indexOf("delete:screen-1");
    expect(resumeAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeGreaterThan(resumeAt);
  });

  it("does not reuse a released screen id from the process-local cache", async () => {
    const fixture = createosFixture({ connectionUrl: "/vnc.html" });
    const api = provider(fixture);
    const worker = new CreateOSSandboxProvider({ apiKey: "test-key", fetch: fixture.fetchImpl });
    const botA = { ...context, botId: "bot-a" };
    const botB = { ...context, botId: "bot-b" };

    await api.connectScreen(computer, { view: "stream" }, botA);
    await worker.releaseScreen(computer, botA);
    await worker.connectScreen(computer, { view: "stream" }, botB);
    await api.connectScreen(computer, { view: "stream" }, botA);

    expect(fixture.calls.filter((call) => call.endsWith("/computer/screens"))).toEqual([
      "POST /v1/sandboxes/sbx-1/computer/screens",
    ]);
    expect(fixture.calls.filter((call) => call.includes("/connect")).at(-1)).toBe(
      "GET /v1/sandboxes/sbx-1/computer/screens/screen-1/connect",
    );
  });

  it("keeps a screen assignment when deletion fails so a later release can retry", async () => {
    const fixture = createosFixture({ connectionUrl: "/vnc.html", failScreenDeletes: 1 });
    const api = provider(fixture);
    const worker = new CreateOSSandboxProvider({ apiKey: "test-key", fetch: fixture.fetchImpl });
    const botA = { ...context, botId: "bot-a" };
    const botB = { ...context, botId: "bot-b" };

    await api.connectScreen(computer, { view: "stream" }, botA);
    await api.connectScreen(computer, { view: "stream" }, botB);
    await expect(api.releaseScreen(computer, botB)).rejects.toThrow(/unavailable/);

    await worker.connectScreen(computer, { view: "stream" }, botB);
    expect(
      fixture.calls.filter((call) => call === "POST /v1/sandboxes/sbx-1/computer/screens"),
    ).toHaveLength(1);
    expect(fixture.calls.filter((call) => call.includes("/connect")).at(-1)).toBe(
      "GET /v1/sandboxes/sbx-1/computer/screens/screen-1/connect",
    );

    await expect(worker.releaseScreen(computer, botB)).resolves.toBeUndefined();
    expect(
      fixture.calls.filter(
        (call) => call === "DELETE /v1/sandboxes/sbx-1/computer/screens/screen-1",
      ),
    ).toHaveLength(2);
  });

  it("does not export the screen-assignment directory", async () => {
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "POST" && url.pathname.endsWith("/exec")) {
        const command = (JSON.parse(String(init?.body)) as { args: string[] }).args[3] ?? "";
        if (command.includes("os.listdir")) {
          const listing = command.includes("/.rakazo")
            ? JSON.stringify([{ name: "screens.json", kind: "file", size: 2 }])
            : JSON.stringify([
                { name: ".rakazo", kind: "dir", size: 0 },
                { name: "notes.txt", kind: "file", size: 5 },
              ]);
          return jsonResponse({ result: { stdout: listing, exit_code: 0 } });
        }
        return jsonResponse({ result: { stdout: "", exit_code: 0 } });
      }
      if (url.pathname.endsWith("/files")) return new Response(new TextEncoder().encode("notes"));
      return jsonResponse({});
    }) as typeof fetch;
    const files: PortableFile[] = [];
    for await (const file of new CreateOSSandboxProvider({
      apiKey: "test-key",
      fetch: fetchImpl,
    }).exportWorkspace(computer, context)) {
      files.push(file);
    }
    expect(files.map((file) => file.path)).toEqual(["notes.txt"]);
  });
});

/**
 * Stateful CreateOS control plane. Statuses move the way the docs describe: a transitional
 * status is reported once, then settles on the next read. Anything inside a sandbox that is
 * not running answers 404 "sandbox not found or not running", as the exec endpoint does.
 */
function createosControlPlane(
  options: { status?: SandboxStatus; resumeTo?: SandboxStatus; failExec?: () => Response } = {},
) {
  const sandboxes = new Map<string, SandboxStatus>();
  if (options.status) sandboxes.set("sbx-1", options.status);
  const settlesTo: Partial<Record<SandboxStatus, SandboxStatus>> = {
    creating: "running",
    pausing: "paused",
    resuming: options.resumeTo ?? "running",
    destroying: "destroyed",
  };
  const calls: string[] = [];
  const bodies: Array<{ route: string; body: unknown }> = [];
  let created = 0;
  const view = (id: string, status: SandboxStatus) => jsonResponse({ id, status });
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const route = `${method} ${url.pathname}`;
    calls.push(route);
    if (typeof init?.body === "string") bodies.push({ route, body: JSON.parse(init.body) });
    if (route === "POST /v1/sandboxes") {
      created += 1;
      const id = `sbx-new-${created}`;
      sandboxes.set(id, "creating");
      return view(id, "creating");
    }
    const [, , , id = "", resource = ""] = url.pathname.split("/");
    const status = sandboxes.get(id);
    if (!status) return failResponse(404, "not_found", "sandbox not found or not running");
    if (resource === "" && method === "GET") {
      const next = settlesTo[status];
      if (next) sandboxes.set(id, next);
      return view(id, status);
    }
    if (resource === "" && method === "PATCH") return view(id, status);
    if (resource === "" && method === "DELETE") {
      sandboxes.set(id, "destroyed");
      return view(id, "destroyed");
    }
    if (resource === "pause") {
      if (status !== "running") return failResponse(409, "invalid_state", "sandbox is not running");
      sandboxes.set(id, "pausing");
      return view(id, "pausing");
    }
    if (resource === "resume") {
      if (status !== "paused" && status !== "error") {
        return failResponse(409, "invalid_state", "sandbox is not paused or in error");
      }
      sandboxes.set(id, "resuming");
      return view(id, "resuming");
    }
    if (status !== "running") {
      return failResponse(404, "not_found", "sandbox not found or not running");
    }
    if (resource === "exec") {
      return options.failExec?.() ?? jsonResponse({ result: { stdout: "ok\n", exit_code: 0 } });
    }
    if (resource === "files") return failResponse(404, "file_not_found", "file not found");
    return jsonResponse({});
  }) as typeof fetch;
  return {
    calls,
    bodies,
    fetchImpl,
    status: (id = "sbx-1") => sandboxes.get(id),
    provider: () => new CreateOSSandboxProvider({ apiKey: "test-key", fetch: fetchImpl }),
  };
}

async function runEcho(target: CreateOSSandboxProvider): Promise<ProcessEvent[]> {
  const events: ProcessEvent[] = [];
  for await (const event of target.execute(computer, { argv: ["echo", "ok"] }, context)) {
    events.push(event);
  }
  return events;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

const existing = {
  botId: "bot-a",
  homePath: "/unused",
  providerRef: "sbx-1",
  providerKind: "createos" as const,
};

describe("CreateOS sandbox lifecycle", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each<{
    status?: SandboxStatus;
    resumeTo?: SandboxStatus;
    outcome: "ran" | "gone";
    resumed: boolean;
    deleted: boolean;
  }>([
    { status: "running", outcome: "ran", resumed: false, deleted: false },
    { status: "creating", outcome: "ran", resumed: false, deleted: false },
    { status: "resuming", outcome: "ran", resumed: false, deleted: false },
    { status: "pausing", outcome: "ran", resumed: true, deleted: false },
    { status: "paused", outcome: "ran", resumed: true, deleted: false },
    { status: "error", outcome: "ran", resumed: true, deleted: false },
    { status: "paused", resumeTo: "error", outcome: "gone", resumed: true, deleted: true },
    { status: "error", resumeTo: "error", outcome: "gone", resumed: true, deleted: true },
    { status: "failed", outcome: "gone", resumed: false, deleted: true },
    { status: "destroying", outcome: "gone", resumed: false, deleted: false },
    { status: "destroyed", outcome: "gone", resumed: false, deleted: false },
    { status: undefined, outcome: "gone", resumed: false, deleted: false },
  ])(
    "runs a command on a $status sandbox (resume ends $resumeTo): $outcome",
    async ({ status, resumeTo, outcome, resumed, deleted }) => {
      const plane = createosControlPlane({ status, resumeTo });

      if (outcome === "ran") {
        expect((await runEcho(plane.provider())).at(-1)).toEqual({ type: "exit", code: 0 });
        expect(plane.status()).toBe("running");
      } else {
        const error = await rejection(runEcho(plane.provider()));
        expect(error).toMatchObject({ name: "SandboxNotFoundError" });
        expect(isSandboxGoneError(error)).toBe(true);
      }
      expect(plane.calls.includes("POST /v1/sandboxes/sbx-1/resume")).toBe(resumed);
      expect(plane.calls.includes("DELETE /v1/sandboxes/sbx-1")).toBe(deleted);
    },
  );

  it.each<{
    status?: SandboxStatus;
    resumeTo?: SandboxStatus;
    fresh: boolean;
    resumed: boolean;
    deleted: boolean;
  }>([
    { status: "running", fresh: false, resumed: false, deleted: false },
    { status: "creating", fresh: false, resumed: false, deleted: false },
    { status: "resuming", fresh: false, resumed: false, deleted: false },
    { status: "pausing", fresh: false, resumed: true, deleted: false },
    { status: "paused", fresh: false, resumed: true, deleted: false },
    { status: "error", fresh: false, resumed: true, deleted: false },
    { status: "paused", resumeTo: "error", fresh: true, resumed: true, deleted: true },
    { status: "failed", fresh: true, resumed: false, deleted: true },
    { status: "destroying", fresh: true, resumed: false, deleted: false },
    { status: "destroyed", fresh: true, resumed: false, deleted: false },
    { status: undefined, fresh: true, resumed: false, deleted: false },
  ])(
    "provisions over a $status sandbox (resume ends $resumeTo): fresh $fresh",
    async ({ status, resumeTo, fresh, resumed, deleted }) => {
      const plane = createosControlPlane({ status, resumeTo });
      const ref = await plane.provider().provision(existing, context);

      expect(ref.fresh).toBe(fresh);
      expect(ref.providerRef).toBe(fresh ? "sbx-new-1" : "sbx-1");
      expect(plane.status(ref.providerRef)).toBe("running");
      expect(plane.calls.includes("POST /v1/sandboxes/sbx-1/resume")).toBe(resumed);
      expect(plane.calls.includes("DELETE /v1/sandboxes/sbx-1")).toBe(deleted);
      expect(plane.calls.includes("PATCH /v1/sandboxes/sbx-1")).toBe(!fresh);
    },
  );

  it.each<{ status?: SandboxStatus; settled?: SandboxStatus }>([
    { status: "running", settled: "pausing" },
    { status: "pausing", settled: "paused" },
    { status: "paused", settled: "paused" },
    { status: "destroyed", settled: "destroyed" },
    { status: undefined, settled: undefined },
  ])("stops a $status sandbox", async ({ status, settled }) => {
    const plane = createosControlPlane({ status });
    await expect(plane.provider().stop(computer, context)).resolves.toBeUndefined();
    expect(plane.status()).toBe(settled);
  });

  it("does not report an errored sandbox as stopped", async () => {
    const plane = createosControlPlane({ status: "error" });
    const error = await rejection(plane.provider().stop(computer, context));
    expect(error).toBeInstanceOf(CreateOSHttpError);
    expect(error).toMatchObject({ status: 409, code: "invalid_state" });
  });

  it.each([
    { status: 401, response: () => failResponse(401, "unauthorized", "key not found") },
    {
      status: 402,
      response: () => failResponse(402, "insufficient_credit", "insufficient credit"),
    },
    { status: 429, response: () => failResponse(429, "rate_limited", "too many requests") },
    { status: 500, response: () => errorResponse(500, "internal error") },
  ])("does not treat a $status from a running sandbox as gone", async ({ status, response }) => {
    const plane = createosControlPlane({ status: "running", failExec: response });
    const error = await rejection(runEcho(plane.provider()));

    expect(error).toBeInstanceOf(CreateOSHttpError);
    expect(error).toMatchObject({ name: "CreateOSHttpError", status });
    expect(isSandboxGoneError(error)).toBe(false);
    expect(plane.calls).not.toContain("GET /v1/sandboxes/sbx-1");
  });

  it("parses the fail envelope into a message and stable code", async () => {
    const plane = createosControlPlane({
      status: "running",
      failExec: () => failResponse(401, "unauthorized", "key not found"),
    });
    const error = await rejection(runEcho(plane.provider()));
    expect(error).toMatchObject({
      code: "unauthorized",
      message: "CreateOS request failed (401): code: unauthorized, error: key not found",
    });
  });

  it("keeps a missing file inside a running sandbox separate from a gone sandbox", async () => {
    const plane = createosControlPlane({ status: "running" });
    const error = await rejection(plane.provider().readFile(computer, "missing.txt", context));

    expect(error).toMatchObject({ name: "CreateOSHttpError", status: 404 });
    expect(isSandboxGoneError(error)).toBe(false);
    expect(plane.calls).not.toContain("POST /v1/sandboxes/sbx-1/resume");
  });

  it("does not resume a stopped sandbox to release its screen", async () => {
    const plane = createosControlPlane({ status: "paused" });
    await expect(plane.provider().releaseScreen(computer, context)).resolves.toBeUndefined();
    expect(plane.status()).toBe("paused");
    expect(plane.calls).not.toContain("POST /v1/sandboxes/sbx-1/resume");
  });

  it.each<{ status?: SandboxStatus; running: boolean }>([
    { status: "running", running: true },
    { status: "pausing", running: false },
    { status: "paused", running: false },
    { status: "error", running: false },
    { status: undefined, running: false },
  ])("reports a $status sandbox running: $running", async ({ status, running }) => {
    const plane = createosControlPlane({ status });
    await expect(plane.provider().isRunning(computer, context)).resolves.toBe(running);
    await expect(plane.provider().isRunning({ ...computer, kind: "e2b" }, context)).resolves.toBe(
      false,
    );
    expect(plane.calls.filter((call) => !call.startsWith("GET "))).toEqual([]);
  });

  it("does not guess whether a sandbox runs while the control plane is unavailable", async () => {
    const provider = new CreateOSSandboxProvider({
      apiKey: "test-key",
      fetch: (async () => errorResponse(503, "unavailable")) as typeof fetch,
    });
    const error = await rejection(provider.isRunning(computer, context));
    expect(error).toMatchObject({ name: "CreateOSHttpError", status: 503 });
    expect(isSandboxGoneError(error)).toBe(false);
  });

  it("reuses a running sandbox when the auto-pause update fails", async () => {
    const plane = createosControlPlane({ status: "running" });
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) =>
      init?.method === "PATCH"
        ? errorResponse(503, "unavailable")
        : plane.fetchImpl(input, init)) as typeof fetch;
    const ref = await new CreateOSSandboxProvider({
      apiKey: "test-key",
      fetch: fetchImpl,
    }).provision(existing, context);
    expect(ref).toMatchObject({ providerRef: "sbx-1", fresh: false });
  });

  it.each<{ status?: SandboxStatus; outcome: "resumed" | "gone" }>([
    { status: "paused", outcome: "resumed" },
    { status: "destroyed", outcome: "gone" },
    { status: undefined, outcome: "gone" },
  ])("keeps a $status sandbox alive: $outcome", async ({ status, outcome }) => {
    const plane = createosControlPlane({ status });
    const keepAlive = plane.provider().keepAlive(computer);
    if (outcome === "resumed") {
      await expect(keepAlive).resolves.toBeUndefined();
      expect(plane.status()).toBe("running");
    } else {
      expect(isSandboxGoneError(await rejection(keepAlive))).toBe(true);
    }
  });

  it.each<{ idleMs?: string; create?: number; patch: Record<string, unknown> }>([
    { idleMs: undefined, create: 1_200, patch: { auto_pause_after_seconds: 1_200 } },
    { idleMs: "30000", create: 630, patch: { auto_pause_after_seconds: 630 } },
    { idleMs: "3600000", create: 7_200, patch: { auto_pause_after_seconds: 7_200 } },
    { idleMs: "43200000", create: 86_400, patch: { auto_pause_after_seconds: 86_400 } },
    { idleMs: "86400000", create: undefined, patch: { disable_auto_pause: true } },
    { idleMs: "0", create: undefined, patch: { disable_auto_pause: true } },
  ])(
    "sets CreateOS auto-pause behind a $idleMs ms sleep window",
    async ({ idleMs, create, patch }) => {
      if (idleMs !== undefined) vi.stubEnv("SANDBOX_IDLE_MS", idleMs);
      const fresh = createosControlPlane();
      await fresh.provider().provision({ botId: "bot-a", homePath: "/unused" }, context);
      const reused = createosControlPlane({ status: "running" });
      await reused.provider().provision(existing, context);

      const createBody = fresh.bodies.find((entry) => entry.route === "POST /v1/sandboxes")?.body;
      expect((createBody as { auto_pause_after_seconds?: number }).auto_pause_after_seconds).toBe(
        create,
      );
      expect(reused.bodies.find((entry) => entry.route.startsWith("PATCH"))?.body).toEqual(patch);
    },
  );
});

describe("CreateOS screen URL hosts", () => {
  const base = "https://api.sb.createos.sh";

  it.each([
    "https://api.sb.createos.sh/vnc.html",
    "https://sandbox.app.sb.createos.sh/vnc.html?token=t",
    "https://novnc.api.sb.createos.sh/vnc.html",
  ])("allows %s", (value) => {
    expect(isAllowedCreateOSScreenUrl(new URL(value), base)).toBe(true);
  });

  it.each([
    "https://evil.example/vnc.html",
    "https://api.sb.createos.sh.evil.example/vnc.html",
    "https://sandbox.app.sb.createos.sh:8443/vnc.html",
    "http://api.sb.createos.sh/vnc.html",
    "https://user:pass@sandbox.app.sb.createos.sh/vnc.html",
  ])("rejects %s", (value) => {
    expect(isAllowedCreateOSScreenUrl(new URL(value), base)).toBe(false);
  });

  it("allows the base URL hostname and port", () => {
    const custom = "https://sandbox.example.test:8443";
    expect(
      isAllowedCreateOSScreenUrl(new URL("https://sandbox.example.test:8443/vnc.html"), custom),
    ).toBe(true);
    expect(
      isAllowedCreateOSScreenUrl(new URL("https://sandbox.example.test/vnc.html"), custom),
    ).toBe(true);
    expect(
      isAllowedCreateOSScreenUrl(
        new URL("https://novnc.sandbox.example.test:8443/vnc.html"),
        custom,
      ),
    ).toBe(false);
    expect(
      isAllowedCreateOSScreenUrl(new URL("https://sandbox.example.test:9443/vnc.html"), custom),
    ).toBe(false);
  });

  it("keeps a custom base on that host and its subdomains", () => {
    const custom = "https://sandbox.example.test";
    expect(
      isAllowedCreateOSScreenUrl(new URL("https://sandbox.example.test/vnc.html"), custom),
    ).toBe(true);
    expect(
      isAllowedCreateOSScreenUrl(new URL("https://novnc.sandbox.example.test/vnc.html"), custom),
    ).toBe(true);
    expect(isAllowedCreateOSScreenUrl(new URL("https://other.example.test/vnc.html"), custom)).toBe(
      false,
    );
    expect(
      isAllowedCreateOSScreenUrl(new URL("https://sandbox.app.sb.createos.sh/vnc.html"), custom),
    ).toBe(false);
  });

  it("allows loopback http only for a loopback base", () => {
    expect(
      isAllowedCreateOSScreenUrl(
        new URL("http://127.0.0.1:8080/vnc.html"),
        "http://127.0.0.1:8080",
      ),
    ).toBe(true);
    expect(isAllowedCreateOSScreenUrl(new URL("http://127.0.0.1:8080/vnc.html"), base)).toBe(false);
  });
});

describe("CreateOS screen map", () => {
  async function mapOp(dir: string, op: string, key: string, screen: string) {
    const { stdout } = await execFileAsync("python3", [
      "-c",
      CREATEOS_SCREEN_MAP_SCRIPT,
      CREATEOS_SCREEN_MAP_SENTINEL,
      op,
      key,
      screen,
      path.join(dir, "screens.json"),
    ]);
    return stdout.trim();
  }

  it("gives two sessions distinct screens when they claim the primary together", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "createos-map-"));
    const [first, second] = await Promise.all([
      mapOp(dir, "put", "bot-a", "screen-0"),
      mapOp(dir, "put", "bot-b", "screen-0"),
    ]);
    expect([first, second].sort()).toEqual(["NEED_CREATE", "screen-0"]);
    const stored = JSON.parse(await mapOp(dir, "read", "", "")) as Record<string, string>;
    expect(Object.values(stored).filter((id) => id === "screen-0")).toHaveLength(1);
  });

  it("keeps a draining screen id for retry and lets a new claim replace it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "createos-map-"));
    expect(await mapOp(dir, "put", "bot-b", "screen-1")).toBe("screen-1");
    expect(await mapOp(dir, "begin-release", "bot-b", "")).toBe("screen-1");
    const draining = JSON.parse(await mapOp(dir, "read", "", "")) as Record<string, string>;
    expect(draining["bot-b"]).toBe("draining:screen-1");

    expect(await mapOp(dir, "abort-release", "bot-b", "screen-1")).toBe("ok");
    const restored = JSON.parse(await mapOp(dir, "read", "", "")) as Record<string, string>;
    expect(restored["bot-b"]).toBe("screen-1");

    expect(await mapOp(dir, "begin-release", "bot-b", "")).toBe("screen-1");
    expect(await mapOp(dir, "put", "bot-b", "screen-2")).toBe("screen-2");
    expect(await mapOp(dir, "commit-release", "bot-b", "screen-1")).toBe("ok");
    const replaced = JSON.parse(await mapOp(dir, "read", "", "")) as Record<string, string>;
    expect(replaced["bot-b"]).toBe("screen-2");
  });
});
