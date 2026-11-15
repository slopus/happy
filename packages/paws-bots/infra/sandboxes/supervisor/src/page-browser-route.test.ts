import { Duplex, PassThrough, Readable, Writable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ exec: vi.fn(), inspect: vi.fn(), stdin: [] as string[] }));
vi.mock("dockerode", () => ({
  default: class {
    getContainer() {
      return mock;
    }
  },
}));

import { supervisorApp } from "./index.js";
import { SCREEN_REUSE_MS } from "./supervisor-logic.js";

beforeEach(() => {
  mock.exec.mockReset();
  mock.inspect.mockReset();
  mock.stdin.length = 0;
  mock.inspect.mockResolvedValue({
    Config: {
      Labels: { "rakazo.managed": "true", "rakazo.botId": "home", "rakazo.spaceId": "space" },
    },
  });
  mock.exec.mockImplementation(async (options: { Cmd: string[] }) => ({
    // Docker's hijacked exec stream is duplex: stdin is written, output is read.
    start: async () =>
      Duplex.from({
        readable: Readable.from([
          Buffer.from(
            options.Cmd.includes("/usr/local/bin/rakazo-page-browser")
              ? JSON.stringify({
                  ok: true,
                  url: "https://example.test",
                  title: "Fixture",
                  tree: "",
                  elements: [],
                })
              : "",
          ),
        ]),
        writable: new Writable({
          write(chunk, _encoding, callback) {
            mock.stdin.push(String(chunk));
            callback();
          },
        }),
      }),
    inspect: async () => ({ ExitCode: 0 }),
  }));
});

async function snapshot(id: string, screen: string, lease: string, home = "home") {
  return supervisorApp.request(`/computers/${id}/browser`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": home,
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": screen,
      "x-rakazo-screen-lease-id": lease,
    },
    body: JSON.stringify({ command: "snapshot" }),
  });
}

it("resolves the owned display and refuses an older fence before running the helper", async () => {
  expect(await (await snapshot("computer-lease", "first", "run:2")).json()).toMatchObject({
    ok: true,
  });
  expect(await (await snapshot("computer-lease", "second", "other:2")).json()).toMatchObject({
    ok: true,
  });
  expect(mock.exec.mock.calls.at(-1)?.[0]).toMatchObject({
    Env: [
      "DISPLAY=:2",
      "RAKAZO_CDP_PORT=9223",
      "HOME=/home/rakazo",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "RAKAZO_BROWSER_WATCH_STDIN=1",
      "RAKAZO_BROWSER_ARGS_STDIN=1",
    ],
  });
  mock.exec.mockClear();
  expect(await (await snapshot("computer-lease", "first", "run:1")).json()).toMatchObject({
    ok: false,
  });
  expect(mock.exec).not.toHaveBeenCalled();
});

it("rejects another computer identity before any command executes", async () => {
  expect(
    await (await snapshot("computer-identity", "first", "run:1", "foreign-home")).json(),
  ).toMatchObject({ ok: false });
  expect(mock.exec).not.toHaveBeenCalled();
});

it.each(["http", "https"])(
  "rejects %s URL credentials before executing any command",
  async (scheme) => {
    const response = await supervisorApp.request("/computers/computer-credentials/browser", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "navigate",
        url: `${scheme}://example:fake-password@example.test`,
      }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mock.exec).not.toHaveBeenCalled();
    expect(mock.inspect).not.toHaveBeenCalled();
  },
);

it.each([
  [
    "a saved-login fill that does not say which field it is",
    { kind: "fill", ref: "e1", text: "fake-password-1", origin: "https://login.example.test" },
  ],
  [
    "a card fill without the merchant's origin",
    { kind: "fill", ref: "e1", text: "4242424242424242", field: "card" },
  ],
  [
    "a card fill without its ref or card field",
    { kind: "fill", text: "4242424242424242", origin: "https://shop.example.test", field: "card" },
  ],
  [
    "a ref-less fill that is not a card",
    {
      kind: "fill",
      text: "fake-password-1",
      origin: "https://login.example.test",
      field: "password",
      cardField: "number",
    },
  ],
  [
    "a ref-less card type",
    {
      kind: "type",
      text: "4242424242424242",
      origin: "https://shop.example.test",
      field: "card",
      cardField: "number",
    },
  ],
  [
    "a ref-less card fill without the merchant's origin",
    { kind: "fill", text: "4242424242424242", field: "card", cardField: "number" },
  ],
  [
    "an unknown card field",
    {
      kind: "fill",
      text: "4242",
      origin: "https://shop.example.test",
      field: "card",
      cardField: "track2",
    },
  ],
  ["a code fill without its origin", { kind: "fill", ref: "e1", text: "123456", field: "code" }],
  [
    "a code fill without its ref",
    { kind: "fill", text: "123456", origin: "https://login.example.test", field: "code" },
  ],
  [
    "a code typed by key presses",
    {
      kind: "type",
      ref: "e1",
      text: "123456",
      origin: "https://login.example.test",
      field: "code",
    },
  ],
  [
    "a pay token without the merchant's origin",
    { kind: "pay_token", text: "lpt_fake_secret", merchantAccountId: "acct_fake123" },
  ],
  [
    "a pay token without its merchant account",
    { kind: "pay_token", text: "lpt_fake_secret", origin: "https://shop.example.test" },
  ],
])("rejects %s", async (_, action) => {
  const response = await supervisorApp.request("/computers/computer-login/browser", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ command: "act", actions: [action] }),
  });
  // The refusal is the supervisor's own, with a code that proves nothing was sent to the computer.
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ ok: false, code: "invalid_browser_request" });
  expect(mock.exec).not.toHaveBeenCalled();
});

it("closes helper stdin when the request is cancelled", async () => {
  const stream = new PassThrough();
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const defaultExec = mock.exec.getMockImplementation()!;
  mock.exec.mockImplementation(async (options: { Cmd: string[]; AttachStdin?: boolean }) => {
    if (!options.Cmd.includes("/usr/local/bin/rakazo-page-browser")) return defaultExec(options);
    expect(options.AttachStdin).toBe(true);
    return {
      start: async (options: { stdin: boolean }) => {
        expect(options.stdin).toBe(true);
        started();
        return stream;
      },
      inspect: async () => ({ ExitCode: 130 }),
    };
  });
  const response = supervisorApp.request("/computers/computer-cancel/browser", {
    method: "POST",
    signal: controller.signal,
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "home",
      "x-rakazo-space-id": "space",
    },
    body: JSON.stringify({ command: "act", actions: [{ kind: "click", ref: "test-ref" }] }),
  });
  await ready;
  controller.abort();
  expect(await (await response).json()).toMatchObject({ ok: false, uncertain: true });
  expect(stream.destroyed).toBe(true);
});

it.each([
  [
    "saved-login",
    { text: "fake-password-1", origin: "https://login.example.test", field: "password" },
  ],
  ["card", { text: "4242424242424242", origin: "https://shop.example.test", field: "card" }],
  ["one-time code", { text: "123456", origin: "https://login.example.test", field: "code" }],
  [
    "ref-less card",
    {
      ref: undefined,
      text: "4242424242424242",
      origin: "https://shop.example.test",
      field: "card",
      cardField: "number",
    },
  ],
  [
    "pay token",
    {
      kind: "pay_token",
      ref: undefined,
      text: "lpt_fake_secret",
      origin: "https://shop.example.test",
      merchantAccountId: "acct_fake123",
    },
  ],
])("sends a %s fill only over stdin, never in the helper's arguments", async (_, fill) => {
  const actions = [{ kind: "fill", ref: "e1", ...fill }];
  const response = await supervisorApp.request("/computers/computer-login/browser", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "home",
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": "first",
      "x-rakazo-screen-lease-id": "run:9",
    },
    body: JSON.stringify({ command: "act", actions }),
  });
  expect(await response.json()).toMatchObject({ ok: true });
  const helperCall = mock.exec.mock.calls.find(([options]) =>
    options.Cmd.includes("/usr/local/bin/rakazo-page-browser"),
  )!;
  expect(JSON.stringify(helperCall[0].Cmd)).not.toContain(fill.text);
  expect(helperCall[0].Env).toContain("RAKAZO_BROWSER_ARGS_STDIN=1");
  expect(mock.stdin.join("")).toBe(`${JSON.stringify({ command: "act", actions })}\n`);
});

it.each([
  [{ command: "snapshot" }, "Retry once"],
  [{ command: "act", actions: [{ kind: "click", ref: "e1" }] }, "Inspect the screen"],
])("reports a helper that exceeds its deadline as a timeout: %j", async (body, advice) => {
  const defaultExec = mock.exec.getMockImplementation()!;
  mock.exec.mockImplementation(async (options: { Cmd: string[] }) => {
    if (options.Cmd.includes("/usr/local/bin/rakazo-page-browser")) {
      return {
        start: async () =>
          Duplex.from({ readable: Readable.from([]), writable: new PassThrough() }),
        inspect: async () => ({ ExitCode: 124 }),
      };
    }
    if (options.Cmd[0] === "sh") {
      return {
        start: async () => Readable.from([]),
        inspect: async () => ({ ExitCode: 1 }),
      };
    }
    return defaultExec(options);
  });
  const response = await supervisorApp.request("/computers/computer-timeout/browser", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "home",
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": "first",
      "x-rakazo-screen-lease-id": "run:1",
    },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as { error: string; uncertain: boolean };
  expect(result).toMatchObject({
    ok: false,
    fallback: "computer_act",
    error: expect.stringContaining("timed out"),
  });
  expect(result.error).toContain(advice);
  expect(result.uncertain).toBe(body.command === "act");
});

it("passes a settled step error through with the page, without a desktop fallback", async () => {
  const settled = {
    ok: false,
    completed: 0,
    uncertain: false,
    url: "https://portal.example.test/",
    title: "Portal",
    tree: '- combobox "Year" [e5] options: "2023", "2024"',
    elements: [
      { ref: "e5", role: "combobox", name: "Year", options: [{ label: "2024", value: "2024" }] },
    ],
    error: 'This dropdown has no option "2019". Its options: "2023", "2024".',
  };
  const defaultExec = mock.exec.getMockImplementation()!;
  mock.exec.mockImplementation(async (options: { Cmd: string[] }) =>
    options.Cmd.includes("/usr/local/bin/rakazo-page-browser")
      ? {
          start: async () =>
            Duplex.from({
              readable: Readable.from([Buffer.from(JSON.stringify(settled))]),
              writable: new PassThrough(),
            }),
          inspect: async () => ({ ExitCode: 0 }),
        }
      : defaultExec(options),
  );
  const response = await supervisorApp.request("/computers/computer-settled/browser", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "home",
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": "first",
      "x-rakazo-screen-lease-id": "run:1",
    },
    body: JSON.stringify({ command: "act", actions: [{ kind: "fill", ref: "e5", text: "2019" }] }),
  });
  const result = await response.json();
  expect(result).toEqual(settled);
  expect(result).not.toHaveProperty("fallback");
});

async function uploadRequest(roots?: unknown) {
  return supervisorApp.request("/computers/computer-upload/browser", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "home",
      "x-rakazo-space-id": "space",
    },
    body: JSON.stringify({
      command: "act",
      actions: [{ kind: "upload", ref: "e1", paths: ["bots/b1/file.txt"], roots }],
    }),
  });
}

it.each([undefined, ["bots/b1", "shared"]])("forwards trusted upload roots: %j", async (roots) => {
  expect(await (await uploadRequest(roots)).json()).toMatchObject({ ok: true });
  expect(JSON.parse(mock.stdin.join("")).actions[0]).toEqual({
    kind: "upload",
    ref: "e1",
    paths: ["bots/b1/file.txt"],
    ...(roots ? { roots } : {}),
  });
});

it.each([["a", "b", "c"], [""], ["x".repeat(1025)]])(
  "rejects invalid upload roots before running commands: %j",
  async (...roots) => {
    expect((await uploadRequest(roots)).status).toBeGreaterThanOrEqual(400);
    expect(mock.exec).not.toHaveBeenCalled();
    expect(mock.inspect).not.toHaveBeenCalled();
  },
);

async function browserRequest(body: Record<string, unknown>) {
  return supervisorApp.request("/computers/computer-downloads/browser", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "home",
      "x-rakazo-space-id": "space",
    },
    body: JSON.stringify(body),
  });
}

it.each([
  { command: "navigate", url: "https://bank.example/files/statement.pdf" },
  { command: "act", actions: [{ kind: "click", ref: "e1" }] },
  { command: "snapshot" },
])("forwards the bot's download folder: $command", async (command) => {
  const body = { ...command, downloads: "bots/b1/Downloads" };
  expect(await (await browserRequest(body)).json()).toMatchObject({ ok: true });
  expect(JSON.parse(mock.stdin.join(""))).toEqual(body);
});

it("forwards a snapshot's query", async () => {
  const body = { command: "snapshot", query: "newsletter signup" };
  expect(await (await browserRequest(body)).json()).toMatchObject({ ok: true });
  expect(JSON.parse(mock.stdin.join(""))).toEqual(body);
});

it.each(["", "x".repeat(1025), 7])(
  "rejects an invalid download folder before running commands: %j",
  async (downloads) => {
    const body = { command: "act", actions: [{ kind: "click", ref: "e1" }], downloads };
    expect((await browserRequest(body)).status).toBeGreaterThanOrEqual(400);
    expect(mock.exec).not.toHaveBeenCalled();
  },
);

it("forwards a purchase approval on a click step, and nothing else on it", async () => {
  const click = {
    kind: "click",
    ref: "e1",
    approved: true,
    site: "shop.example.test",
    label: "Pay $5",
    amount: "$5",
  };
  expect(
    await (await browserRequest({ command: "act", actions: [{ ...click, extra: 1 }] })).json(),
  ).toMatchObject({ ok: true });
  expect(JSON.parse(mock.stdin.join("")).actions[0]).toEqual(click);
});

it("forwards an approved click on a page without a host, whose site is empty", async () => {
  const click = { kind: "click", ref: "e1", approved: true, site: "", label: "Pay", amount: "" };
  expect(await (await browserRequest({ command: "act", actions: [click] })).json()).toMatchObject({
    ok: true,
  });
  expect(JSON.parse(mock.stdin.join("")).actions[0]).toEqual(click);
});

it("forwards a purchase check without acting", async () => {
  const body = {
    command: "purchase_check",
    actions: [{ kind: "click", ref: "e1" }, { kind: "fill_card" }],
    desktop: true,
    enter: false,
    points: [{ x: 640, y: 400 }],
    unplaced: true,
  };
  expect(await (await browserRequest(body)).json()).toMatchObject({ ok: true });
  expect(JSON.parse(mock.stdin.join(""))).toEqual(body);
  const helper = mock.exec.mock.calls.find(([options]) =>
    options.Cmd.includes("/usr/local/bin/rakazo-page-browser"),
  )!;
  expect(helper[0].Cmd).toContain("purchase_check");
});

it.each([
  { command: "purchase_check", actions: Array.from({ length: 25 }, () => ({ kind: "click" })) },
  { command: "purchase_check", desktop: "yes" },
  { command: "purchase_check", unplaced: "yes" },
  { command: "purchase_check", points: [{ x: "1", y: 2 }] },
  { command: "purchase_check", points: Array.from({ length: 25 }, () => ({ x: 1, y: 2 })) },
  { command: "act", actions: [{ kind: "click", ref: "e1", site: "x".repeat(254) }] },
  { command: "act", actions: [{ kind: "click", ref: "e1", label: "x".repeat(201) }] },
  { command: "act", actions: [{ kind: "click", ref: "e1", amount: 5 }] },
])("rejects a malformed purchase request before running commands: %j", async (body) => {
  expect((await browserRequest(body)).status).toBeGreaterThanOrEqual(400);
  expect(mock.exec).not.toHaveBeenCalled();
});

it.each([undefined, "5"])("forwards the upload size override only when set: %j", async (limit) => {
  const original = process.env.RAKAZO_BROWSER_UPLOAD_MAX_BYTES;
  try {
    if (limit === undefined) delete process.env.RAKAZO_BROWSER_UPLOAD_MAX_BYTES;
    else process.env.RAKAZO_BROWSER_UPLOAD_MAX_BYTES = limit;
    expect(await (await uploadRequest()).json()).toMatchObject({ ok: true });
    const helper = mock.exec.mock.calls.find(([options]) =>
      options.Cmd.includes("/usr/local/bin/rakazo-page-browser"),
    )!;
    const overrides = helper[0].Env.filter((value: string) =>
      value.startsWith("RAKAZO_BROWSER_UPLOAD_MAX_BYTES="),
    );
    expect(overrides).toEqual(
      limit === undefined ? [] : [`RAKAZO_BROWSER_UPLOAD_MAX_BYTES=${limit}`],
    );
  } finally {
    if (original === undefined) delete process.env.RAKAZO_BROWSER_UPLOAD_MAX_BYTES;
    else process.env.RAKAZO_BROWSER_UPLOAD_MAX_BYTES = original;
  }
});

describe("screen setup reuse", () => {
  const bootedAt = "2026-10-27T00:00:00.000Z";
  const helper = (options: { Cmd: string[] }) =>
    options.Cmd.includes("/usr/local/bin/rakazo-page-browser");
  const commands = () =>
    mock.exec.mock.calls.map(([options]) => (helper(options) ? "helper" : "setup"));

  beforeEach(() => {
    mock.inspect.mockResolvedValue({
      Config: {
        Labels: { "rakazo.managed": "true", "rakazo.botId": "home", "rakazo.spaceId": "space" },
      },
      State: { StartedAt: bootedAt },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs only the page helper for a screen set up moments ago", async () => {
    await snapshot("computer-reuse", "reuse", "run:1");
    mock.exec.mockClear();
    expect(await (await snapshot("computer-reuse", "reuse", "run:1")).json()).toMatchObject({
      ok: true,
    });
    expect(commands()).toEqual(["helper"]);
  });

  it("sets the screen up again once its last setup is 30 seconds old", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await snapshot("computer-stale", "stale", "run:1");
    clock.mockReturnValue(now + SCREEN_REUSE_MS);
    mock.exec.mockClear();
    await snapshot("computer-stale", "stale", "run:1");
    expect(commands().at(0)).toBe("setup");
    expect(commands().at(-1)).toBe("helper");
  });

  it("still refuses an older lease on a reused screen", async () => {
    await snapshot("computer-reuse-fence", "fenced", "run:2");
    mock.exec.mockClear();
    expect(await (await snapshot("computer-reuse-fence", "fenced", "run:1")).json()).toMatchObject({
      ok: false,
    });
    expect(mock.exec).not.toHaveBeenCalled();
  });

  it("sets up a reused screen whose browser has exited, then retries the helper once", async () => {
    await snapshot("computer-exited", "exited", "run:1");
    const defaultExec = mock.exec.getMockImplementation()!;
    let helperCalls = 0;
    mock.exec.mockClear();
    mock.exec.mockImplementation(async (options: { Cmd: string[] }) => {
      if (!helper(options) || helperCalls++ > 0) return defaultExec(options);
      return {
        start: async () =>
          Duplex.from({
            readable: Readable.from([
              Buffer.from(
                JSON.stringify({
                  ok: false,
                  error: "CDP not ready on port 9222: unreachable",
                  fallback: "computer_act",
                  uncertain: false,
                }),
              ),
            ]),
            writable: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
          }),
        inspect: async () => ({ ExitCode: 0 }),
      };
    });
    expect(await (await snapshot("computer-exited", "exited", "run:1")).json()).toMatchObject({
      ok: true,
    });
    expect(commands()).toEqual(["helper", "setup", "helper"]);
  });
});

describe("a helper that refuses the command (exit 2)", () => {
  function helperExits(code: number, stdout: string) {
    mock.exec.mockImplementation(async (options: { Cmd: string[] }) => {
      // Screen setup succeeds; only the page helper refuses.
      const helper = options.Cmd.includes("/usr/local/bin/rakazo-page-browser");
      return {
        start: async () =>
          Duplex.from({
            readable: Readable.from([Buffer.from(helper ? stdout : "")]),
            writable: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
          }),
        inspect: async () => ({ ExitCode: helper ? code : 0 }),
      };
    });
  }
  const purchaseCheck = (id: string) =>
    supervisorApp.request(`/computers/${id}/browser`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": "home",
        "x-rakazo-space-id": "space",
        "x-rakazo-screen-id": "first",
        "x-rakazo-screen-lease-id": "run:1",
      },
      body: JSON.stringify({
        command: "purchase_check",
        desktop: true,
        enter: false,
        points: [{ x: 10, y: 10 }],
        unplaced: false,
      }),
    });

  it("passes on an older computer image's refusal of an unknown command", async () => {
    // What rakazo-page-browser on an image from before purchase_check prints.
    helperExits(
      2,
      JSON.stringify({
        ok: false,
        error: "unknown command: purchase_check",
        fallback: "computer_act",
      }),
    );
    expect(await (await purchaseCheck("computer-refusal")).json()).toEqual({
      ok: false,
      error: "unknown command: purchase_check",
      fallback: "computer_act",
    });
  });

  it("still reports an exit 2 without a refusal as unavailable", async () => {
    helperExits(2, "Traceback (most recent call last):");
    expect(await (await purchaseCheck("computer-refusal-garbled")).json()).toMatchObject({
      ok: false,
      error: "Page browser unavailable or interrupted. Inspect the screen before continuing.",
    });
  });
});
