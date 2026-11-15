import type { ProcessEvent } from "@rakazo/adapter-kit";
import {
  SandboxDamagedError,
  SandboxRequestRejectedError,
  SandboxUnresponsiveError,
} from "@rakazo/adapter-kit";
import { COMPUTER_UNRESPONSIVE_ERROR } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerSandboxProvider,
  HEALTH_CHECK_TIMEOUT_MS,
  MAX_SANDBOX_ERROR_RESPONSE_BYTES,
  MAX_SANDBOX_SUCCESS_RESPONSE_BYTES,
  SCREEN_RELEASE_TIMEOUT_MS,
} from "./docker-sandbox.js";
import { isSandboxGoneError } from "./sandbox-errors.js";

const context = {
  operationId: "docker-test",
  traceId: "docker-test",
  spaceId: "workspace",
  userId: "user",
  botId: "bot",
  screenLeaseId: "run-1:1",
  signal: new AbortController().signal,
};

describe("Docker sandbox", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rejects a failed interactive screen instead of returning a viewer fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/screen-mode")
          ? Response.json({ error: "control screen failed to start" }, { status: 400 })
          : Response.json({ running: true }),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    await expect(
      provider.connectScreen(
        { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
        { view: "stream", interactive: true, controlToken: "human-control" },
        context,
      ),
    ).rejects.toThrow("control screen failed to start");
  });

  it("preserves the team screen limit without provider details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: "cannot allocate another screen (limit 4): private detail" },
          { status: 409 },
        ),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    await expect(
      provider.connectScreen(
        { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
        { view: "stream" },
        context,
      ),
    ).rejects.toThrow("This Team Computer cannot allocate another screen (limit 4).");
  });

  it("requires a control token and an explicit route for an interactive screen", async () => {
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const computer = {
      id: "computer",
      botId: "bot",
      kind: "docker" as const,
      providerRef: "computer",
    };
    await expect(
      provider.connectScreen(computer, { view: "stream", interactive: true }, context),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      provider.connectScreen(
        computer,
        { view: "stream", interactive: true, controlToken: "human-control" },
        context,
      ),
    ).rejects.toThrow();
  });

  it("sends the bounded timeout to the supervisor and preserves its honest result", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        stdout: "partial output\n",
        stderr: "command timed out after 75 ms\n",
        code: 124,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const events: ProcessEvent[] = [];

    for await (const event of provider.execute(
      { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
      { argv: ["sleep", "10"], unsetEnv: ["FAILED"], timeoutMs: 75 },
      context,
    )) {
      events.push(event);
    }

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      argv: ["env", "-u", "FAILED", "--", "sleep", "10"],
      cwd: "/home/rakazo",
      timeoutMs: 75,
    });
    expect(events).toEqual([
      { type: "stdout", data: "partial output\n" },
      { type: "stderr", data: "command timed out after 75 ms\n" },
      { type: "exit", code: 124 },
    ]);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-rakazo-bot-id": "bot",
      "x-rakazo-screen-id": "bot",
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-request-id": expect.any(String),
      traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/),
    });
  });

  it("yields stdout from a streaming exec before the command exits", async () => {
    let releaseExit: () => void = () => undefined;
    const exitGate = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(
                encoder.encode(
                  `${JSON.stringify({ type: "stdout", data: "code: ABCD-1234\nhttps://github.com/login/device\n" })}\n`,
                ),
              );
              await exitGate;
              controller.enqueue(encoder.encode(`${JSON.stringify({ type: "exit", code: 0 })}\n`));
              controller.close();
            },
          }),
          { headers: { "content-type": "application/x-ndjson" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const iterator = provider
      .execute(
        { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
        { argv: ["gh", "auth", "login", "--web"], timeoutMs: 5_000 },
        context,
      )
      [Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value).toEqual({
      type: "stdout",
      data: "code: ABCD-1234\nhttps://github.com/login/device\n",
    });
    let exitSeen = false;
    const rest = (async () => {
      const next = await iterator.next();
      exitSeen = true;
      return next;
    })();
    await Promise.resolve();
    expect(exitSeen).toBe(false);
    releaseExit();
    await expect(rest).resolves.toEqual({ value: { type: "exit", code: 0 }, done: false });
  });

  it("ends a stalled streaming exec at its stream deadline and cancels the body", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const encoder = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  encoder.encode(`${JSON.stringify({ type: "stdout", data: "started\n" })}\n`),
                );
              },
              cancel,
            }),
            { headers: { "content-type": "application/x-ndjson" } },
          ),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    try {
      const iterator = provider
        .execute(
          { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
          { argv: ["sleep", "infinity"], timeoutMs: 100 },
          context,
        )
        [Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toEqual({
        value: { type: "stdout", data: "started\n" },
        done: false,
      });
      let settled: unknown;
      iterator.next().then(
        () => (settled = "resolved"),
        (error: unknown) => (settled = error),
      );
      deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
      await vi.waitFor(() => expect(settled).toBeInstanceOf(SandboxUnresponsiveError));
      expect(settled).toMatchObject({
        message: COMPUTER_UNRESPONSIVE_ERROR,
        cause: deadline.signal.reason,
      });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      timeout.mockRestore();
    }
  });

  it("reports a command the computer never answers as an unresponsive computer", async () => {
    const dropped = new TypeError("terminated");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw dropped;
      }),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const events = provider.execute(
      { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
      { argv: ["true"] },
      context,
    );
    await expect(events[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      name: "SandboxUnresponsiveError",
      message: COMPUTER_UNRESPONSIVE_ERROR,
      cause: dropped,
    });
  });

  /** A finished command's stream: what it printed, then exit code 0. */
  const commandOutput = (stdout: string) =>
    new Response(
      [
        ...(stdout ? [JSON.stringify({ type: "stdout", data: stdout })] : []),
        JSON.stringify({ type: "exit", code: 0 }),
      ].join("\n"),
      { headers: { "content-type": "application/x-ndjson" } },
    );

  describe("before a computer is used", () => {
    const computer = {
      id: "computer",
      botId: "bot",
      kind: "docker",
      providerRef: "computer",
    } as const;

    it("uses a computer that can write its home folder", async () => {
      const fetchMock = vi.fn(async () => commandOutput(""));
      vi.stubGlobal("fetch", fetchMock);
      const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
      await provider.prepare(computer, context);
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        "http://supervisor.test/computers/computer/exec",
        expect.objectContaining({
          body: expect.stringContaining(
            JSON.stringify(["/bin/sh", "-c", "test -w . || echo unwritable"]),
          ),
        }),
      );
    });

    it("shares one home probe while callers stop waiting independently", async () => {
      let answer = (_response: Response) => {};
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
      const stopped = new AbortController();
      const first = provider.prepare(computer, { ...context, signal: stopped.signal });
      const second = provider.prepare(computer, context);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      stopped.abort(new Error("stopped"));
      await expect(first).rejects.toThrow("stopped");
      answer(commandOutput(""));
      await expect(second).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("reports a computer that cannot write its home folder as damaged", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => commandOutput("unwritable\n")),
      );
      const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
      await expect(provider.prepare(computer, context)).rejects.toBeInstanceOf(SandboxDamagedError);
    });

    it("does not restart a computer on incomplete unwritable output", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ type: "stdout", data: "unwritable\n" }), {
              headers: { "content-type": "application/x-ndjson" },
            }),
        ),
      );
      const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
      await expect(provider.prepare(computer, context)).resolves.toBeUndefined();
    });

    it("bounds an unanswered preparation check without reporting damage", async () => {
      const deadline = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      try {
        vi.stubGlobal(
          "fetch",
          vi.fn(
            (_url: string, init: RequestInit) =>
              new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
              }),
          ),
        );
        const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
        const check = provider.prepare(computer, context);
        expect(AbortSignal.timeout).toHaveBeenCalledWith(HEALTH_CHECK_TIMEOUT_MS);
        const rejected = expect(check).rejects.not.toBeInstanceOf(SandboxDamagedError);
        deadline.abort(new DOMException("Timed out", "TimeoutError"));
        await rejected;
      } finally {
        vi.mocked(AbortSignal.timeout).mockRestore();
      }
    });

    it("does not blame the home folder when the check itself could not run", async () => {
      const fetchMock = vi.fn(async (url: string) =>
        url.endsWith("/exec")
          ? new Response("supervisor error", { status: 500 })
          : new Response(JSON.stringify({ running: true })),
      );
      vi.stubGlobal("fetch", fetchMock);
      const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
      await expect(provider.prepare(computer, context)).resolves.toBeUndefined();
    });
  });

  describe("after a command goes unanswered", () => {
    const computer = {
      id: "computer",
      botId: "bot",
      kind: "docker",
      providerRef: "computer",
    } as const;
    const exit = (code: number) =>
      new Response(JSON.stringify({ type: "exit", code }), {
        headers: { "content-type": "application/x-ndjson" },
      });
    async function unansweredProvider(fetchMock: ReturnType<typeof vi.fn>) {
      fetchMock.mockRejectedValueOnce(new TypeError("terminated"));
      vi.stubGlobal("fetch", fetchMock);
      const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
      await expect(
        provider
          .execute(computer, { argv: ["true"] }, context)
          [Symbol.asyncIterator]()
          .next(),
      ).rejects.toBeInstanceOf(SandboxUnresponsiveError);
      return provider;
    }

    const checkTimeout = (call: unknown[] | undefined) => {
      if (!call) throw new Error("Expected an exec request");
      return JSON.parse((call[1] as RequestInit).body as string).timeoutMs;
    };

    it("gives every preparation check a short deadline", async () => {
      const fetchMock = vi.fn(async () => exit(0));
      const provider = await unansweredProvider(fetchMock);
      await provider.prepare(computer, context);
      expect(checkTimeout(fetchMock.mock.calls.at(-1))).toBe(HEALTH_CHECK_TIMEOUT_MS);
      await provider.prepare(computer, context);
      expect(checkTimeout(fetchMock.mock.calls.at(-1))).toBe(HEALTH_CHECK_TIMEOUT_MS);
    });

    it("reports the computer damaged when it answers that its home cannot be written", async () => {
      const provider = await unansweredProvider(vi.fn(async () => commandOutput("unwritable\n")));
      await expect(provider.prepare(computer, context)).rejects.toBeInstanceOf(SandboxDamagedError);
    });

    it.each([new Error("stopped"), "stopped"])(
      "does not start a check for an already stopped caller (%s)",
      async (reason) => {
        const fetchMock = vi.fn(async () => exit(0));
        const provider = await unansweredProvider(fetchMock);
        fetchMock.mockClear();
        const stopped = new AbortController();
        stopped.abort(reason);

        await expect(
          provider.prepare(computer, { ...context, signal: stopped.signal }),
        ).rejects.toEqual(reason instanceof Error ? reason : new Error("Request timed out"));
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it("observes a failed check after its only caller stops waiting", async () => {
      let answer = (_response: Response) => {};
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      );
      const provider = await unansweredProvider(fetchMock);
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        const stopped = new AbortController();
        const check = provider.prepare(computer, { ...context, signal: stopped.signal });
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        stopped.abort(new Error("stopped"));
        await expect(check).rejects.toThrow("stopped");

        answer(exit(1));
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();

        fetchMock.mockResolvedValueOnce(exit(1));
        await expect(provider.prepare(computer, context)).rejects.toBeInstanceOf(
          SandboxDamagedError,
        );
        expect(fetchMock).toHaveBeenCalledTimes(3);
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });

    it.each([
      ["answers nothing", () => Promise.reject(new TypeError("terminated"))],
      ["fails the command", async () => exit(1)],
    ])("reports the computer damaged when it %s", async (_name, respond) => {
      const provider = await unansweredProvider(vi.fn(respond));
      await expect(provider.prepare(computer, context)).rejects.toBeInstanceOf(SandboxDamagedError);
    });

    it("stops it without a checkpoint and trusts the restarted computer", async () => {
      const fetchMock = vi.fn(async () => new Response("{}"));
      const provider = await unansweredProvider(fetchMock);
      await provider.stop(computer, context, { discardUnsaved: true });
      expect(fetchMock.mock.calls.at(-1)).toEqual([
        "http://supervisor.test/computers/computer/stop",
        expect.objectContaining({
          headers: expect.objectContaining({ "x-rakazo-discard-unsaved": "1" }),
        }),
      ]);
      await provider.prepare(computer, context);
      expect(checkTimeout(fetchMock.mock.calls.at(-1))).toBe(HEALTH_CHECK_TIMEOUT_MS);
    });

    it("runs one check for callers that need it at the same time", async () => {
      let answer = (_response: Response) => {};
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      );
      const provider = await unansweredProvider(fetchMock);
      const first = provider.prepare(computer, context);
      const second = provider.prepare(computer, context);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      answer(exit(0));
      await Promise.all([first, second]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("lets the other callers' check finish when one caller stops waiting", async () => {
      let answer = (_response: Response) => {};
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      );
      const provider = await unansweredProvider(fetchMock);
      const stopped = new AbortController();
      const first = provider.prepare(computer, { ...context, signal: stopped.signal });
      const second = provider.prepare(computer, context);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      stopped.abort(new Error("stopped"));
      await expect(first).rejects.toThrow("stopped");
      answer(exit(0));
      await expect(second).resolves.toBeUndefined();
    });

    it("checks again after a stall that happened during a passing check", async () => {
      let answer = (_response: Response) => {};
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      );
      const provider = await unansweredProvider(fetchMock);
      const check = provider.prepare(computer, context);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const passing = answer;
      fetchMock.mockRejectedValueOnce(new TypeError("terminated"));
      await expect(
        provider
          .execute(computer, { argv: ["true"] }, context)
          [Symbol.asyncIterator]()
          .next(),
      ).rejects.toBeInstanceOf(SandboxUnresponsiveError);
      passing(exit(0));
      await check;
      fetchMock.mockResolvedValueOnce(exit(0));
      await provider.prepare(computer, context);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });

  it("leaves a command the caller stopped as the caller's own abort", async () => {
    const caller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        caller.abort(new Error("stopped"));
        throw init.signal?.reason;
      }),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const events = provider.execute(
      { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
      { argv: ["true"] },
      { ...context, signal: caller.signal },
    );
    await expect(events[Symbol.asyncIterator]().next()).rejects.toThrow("stopped");
  });

  it("rejects a declared oversized success response without buffering it", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), {
            headers: { "content-length": String(MAX_SANDBOX_SUCCESS_RESPONSE_BYTES + 1) },
          }),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(
      provider.provision({ botId: "bot", homePath: "/tmp/bot" }, context),
    ).rejects.toThrow(`sandbox response exceeds ${MAX_SANDBOX_SUCCESS_RESPONSE_BYTES} bytes`);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it.each([
    [
      { id: "computer", resumed: true, started: true },
      { fresh: false, started: true },
    ],
    [{ id: "computer", resumed: true, started: false }, { fresh: false }],
    [{ id: "computer", resumed: true }, { fresh: false }],
    [{ id: "computer", resumed: false }, { fresh: true }],
  ])("reports whether provisioning started the computer: %j", async (body, expected) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body)),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(
      provider.provision({ botId: "bot", homePath: "/tmp/bot" }, context),
    ).resolves.toStrictEqual({
      id: "computer",
      botId: "bot",
      kind: "docker",
      providerRef: "computer",
      ...expected,
    });
  });

  it("sends the owner's time zone and language with the computer request only when known", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ id: "computer", resumed: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const body = () => JSON.parse(String(fetchMock.mock.lastCall?.[1]?.body));

    await provider.provision(
      { botId: "bot", homePath: "/tmp/bot", timezone: "Europe/Warsaw", language: "pl" },
      context,
    );
    expect(body()).toMatchObject({ timezone: "Europe/Warsaw", language: "pl" });
    await provider.provision({ botId: "bot", homePath: "/tmp/bot" }, context);
    expect(body()).not.toHaveProperty("timezone");
    expect(body()).not.toHaveProperty("language");
  });

  it("translates a 429 computer limit reached error from the supervisor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "Computer limit reached for space (max: 5)" }, { status: 429 }),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(
      provider.provision({ botId: "bot", homePath: "/tmp/bot" }, context),
    ).rejects.toThrow("Computer limit reached for space (max: 5)");
  });

  it("stops a streamed file response at the caller-derived encoded limit", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(1029));
              },
              cancel,
            }),
          ),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(
      provider.readFile(
        { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
        "small.txt",
        context,
        { maxBytes: 1 },
      ),
    ).rejects.toThrow("sandbox response exceeds 1028 bytes");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("accepts a valid encoded envelope above the generic response cap", async () => {
    const maxBytes = 13 * 1024 * 1024;
    const encodedLimit = Math.ceil(maxBytes / 3) * 4 + 1024;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"content":""}', {
            headers: { "content-length": String(encodedLimit) },
          }),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(
      provider.readFile(
        { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
        "large.bin",
        context,
        { maxBytes },
      ),
    ).resolves.toEqual(new Uint8Array());
  });

  it("releases this bot's screen assignment through the supervisor", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await provider.releaseScreen(
      { id: "computer", botId: "home-bot", kind: "docker", providerRef: "computer" },
      context,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://supervisor.test/computers/computer/screen",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          authorization: "Bearer test-token",
          "x-rakazo-bot-id": "home-bot",
          "x-rakazo-screen-id": "bot",
          "x-rakazo-screen-lease-id": "run-1:1",
          "x-rakazo-space-id": "workspace",
        }),
      }),
    );
  });

  it("still releases the screen after the run abort signal has fired", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ error: "computer not found" }, { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const abort = new AbortController();
    abort.abort();

    await expect(
      provider.releaseScreen(
        { id: "computer", botId: "home-bot", kind: "docker", providerRef: "computer" },
        { ...context, signal: abort.signal },
      ),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.signal).not.toBe(abort.signal);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });

  it("reports a supervisor teardown failure instead of a finished release", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "computer screen failed to stop" }, { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const computer = {
      id: "computer",
      botId: "home-bot",
      kind: "docker",
      providerRef: "computer",
    } as const;

    await expect(provider.releaseScreen(computer, context)).rejects.toThrow(
      "sandbox screen release failed: 500",
    );

    fetchMock.mockImplementation(async () =>
      Response.json({ error: "computer screen failed to stop" }, { status: 404 }),
    );
    await expect(provider.releaseScreen(computer, context)).rejects.toThrow(
      "sandbox screen release failed: 404",
    );
  });

  it("bounds screen release even when fetch ignores cancellation", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Promise<Response>(() => undefined),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    const pending = provider.releaseScreen(
      { id: "computer", botId: "home-bot", kind: "docker", providerRef: "computer" },
      context,
    );
    const rejected = expect(pending).rejects.toThrow("sandbox screen release timed out");
    await vi.advanceTimersByTimeAsync(SCREEN_RELEASE_TIMEOUT_MS);

    await rejected;
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("surfaces a supervisor failure from stop and destroy instead of swallowing it", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: "unauthorized" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "stale-token");
    const computer = {
      id: "computer",
      botId: "bot",
      kind: "docker",
      providerRef: "computer",
    } as const;

    await expect(provider.stop(computer, context)).rejects.toThrow(
      'sandbox stop failed: 401 {"error":"unauthorized"}',
    );
    await expect(provider.destroy(computer, context)).rejects.toThrow(
      'sandbox destroy failed: 401 {"error":"unauthorized"}',
    );

    fetchMock.mockImplementation(async () => new Response("boom", { status: 500 }));
    await expect(provider.stop(computer, context)).rejects.toThrow("sandbox stop failed: 500 boom");
    await expect(provider.destroy(computer, context)).rejects.toThrow(
      "sandbox destroy failed: 500 boom",
    );

    fetchMock.mockImplementation(async () => Response.json({ ok: true }));
    await expect(provider.destroy(computer, context)).resolves.toBeUndefined();
    // A 404 that does not say the computer is missing could still leave it running.
    fetchMock.mockImplementation(async () => new Response("404 Not Found", { status: 404 }));
    await expect(provider.destroy(computer, context)).rejects.toThrow(
      "sandbox destroy failed: 404 404 Not Found",
    );
  });

  it("does not buffer an oversized supervisor error body", async () => {
    const cancel = vi.fn();
    const fetchMock = vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          status: 500,
          headers: { "content-length": String(MAX_SANDBOX_ERROR_RESPONSE_BYTES + 1) },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const computer = {
      id: "computer",
      botId: "bot",
      kind: "docker",
      providerRef: "computer",
    } as const;

    await expect(provider.stop(computer, context)).rejects.toThrow("sandbox stop failed: 500");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("stops reading a streamed supervisor error at the byte limit", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_SANDBOX_ERROR_RESPONSE_BYTES + 1));
            },
          }),
          { status: 500 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(
      provider.stop(
        { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
        context,
      ),
    ).rejects.toThrow("sandbox stop failed: 500");
  });

  it("treats a computer the supervisor no longer knows as already stopped and destroyed", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "computer not found" }, { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const computer = {
      id: "computer",
      botId: "bot",
      kind: "docker",
      providerRef: "computer",
    } as const;

    await expect(provider.stop(computer, context)).resolves.toBeUndefined();
    await expect(provider.destroy(computer, context)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("asks the supervisor to cancel orphaned run work when releasing a screen", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    await provider.releaseScreen(
      { id: "computer-1", botId: "bot", kind: "docker", providerRef: "computer-1" },
      { ...context, cancelRunWork: true },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://supervisor.test/computers/computer-1/screen",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ "x-rakazo-cancel-run-work": "1" }),
      }),
    );
  });

  it("preserves only a completed, non-cancelled screen and releases the view on cancellation", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const computer = {
      id: "computer-1",
      botId: "bot",
      kind: "docker",
      providerRef: "computer-1",
    } as const;

    await provider.releaseScreen(computer, { ...context, keepScreenWarm: true });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-rakazo-preserve-screen": "1",
    });

    await provider.releaseScreen(computer, {
      ...context,
      keepScreenWarm: true,
      cancelRunWork: true,
    });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      "x-rakazo-cancel-run-work": "1",
    });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).not.toHaveProperty("x-rakazo-preserve-screen");

    const abort = new AbortController();
    abort.abort();
    await provider.releaseScreen(computer, {
      ...context,
      keepScreenWarm: true,
      signal: abort.signal,
    });
    expect(fetchMock.mock.calls[2]?.[1]?.headers).not.toHaveProperty("x-rakazo-preserve-screen");
  });
});

describe("Docker page browser", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the owned computer screen and lease instead of the generic exec endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ ok: true, title: "Fixture", url: "https://example.test" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    await provider.pageBrowser(
      { id: "computer", botId: "team-home", kind: "docker", providerRef: "computer" },
      { command: "snapshot" },
      context,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://supervisor.test/computers/computer/browser",
      expect.objectContaining({
        redirect: "error",
        signal: context.signal,
        body: JSON.stringify({ command: "snapshot" }),
        headers: expect.objectContaining({
          "x-rakazo-bot-id": "team-home",
          "x-rakazo-screen-lease-id": "run-1:1",
        }),
      }),
    );
  });
});

describe("Docker page browser refusals", () => {
  afterEach(() => vi.unstubAllGlobals());
  const computer = {
    id: "computer",
    botId: "team-home",
    kind: "docker" as const,
    providerRef: "computer",
  };
  const act = { command: "act" as const, actions: [{ kind: "click" as const, ref: "e1" }] };

  async function failure(respond: () => Response | Promise<Response>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond()),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    return provider.pageBrowser(computer, act, context).then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  it("names the supervisor's refusal of a malformed request as one that ran nothing", async () => {
    const error = await failure(() =>
      Response.json({ ok: false, code: "invalid_browser_request" }, { status: 400 }),
    );
    expect(error).toBeInstanceOf(SandboxRequestRejectedError);
  });

  it.each([
    ["another 400", () => Response.json({ error: "bad" }, { status: 400 })],
    ["a 400 that is not JSON", () => new Response("no", { status: 400 })],
    ["a 404", () => Response.json({ code: "invalid_browser_request" }, { status: 404 })],
    ["a 500", () => Response.json({ code: "invalid_browser_request" }, { status: 500 })],
    ["a refused connection", () => Promise.reject(new TypeError("fetch failed"))],
  ])("does not call %s a refusal that ran nothing", async (_name, respond) => {
    const error = await failure(respond);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SandboxRequestRejectedError);
  });
});

describe("Docker sandbox stopped containers", () => {
  const computer = {
    id: "computer",
    botId: "bot",
    kind: "docker" as const,
    providerRef: "computer",
  };

  function supervisorWith(status: Response | (() => Response)) {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/screen-mode")) {
        return Response.json(
          { error: "(HTTP code 409) container stopped/paused - container computer is not running" },
          { status: 400 },
        );
      }
      if (url.endsWith("/computers/computer") && (init?.method ?? "GET") === "GET") {
        return typeof status === "function" ? status() : status;
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats a control revoke on a stopped container as already released", async () => {
    const fetchMock = supervisorWith(() => Response.json({ id: "computer", running: false }));
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(provider.setScreenControl(computer, false, context, "lease-1")).resolves.toBe(
      undefined,
    );

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "http://supervisor.test/computers/computer/screen-mode",
      "http://supervisor.test/computers/computer",
    ]);
  });

  it("reports a deleted container gone so lease cleanup can clear its stale reference", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        { error: "(HTTP code 404) no such container - No such container: computer" },
        { status: 400 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    const error = await provider.setScreenControl(computer, false, context, "lease-1").then(
      () => null,
      (error: unknown) => error,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(isSandboxGoneError(error)).toBe(true);
  });

  it("reports a deleted container gone when running a command", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          stdout: "",
          stderr: "(HTTP code 404) no such container - No such container: computer",
          code: 1,
        }),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    const error = await (async () => {
      for await (const _event of provider.execute(computer, { argv: ["true"] }, context));
    })().then(
      () => null,
      (error: unknown) => error,
    );

    expect(isSandboxGoneError(error)).toBe(true);
  });

  it("reports a stopped container gone when running a command", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("/exec")
        ? Response.json({ error: "computer is not running" }, { status: 409 })
        : Response.json({ id: "computer", running: false }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    const error = await (async () => {
      for await (const _event of provider.execute(computer, { argv: ["true"] }, context));
    })().then(
      () => null,
      (error: unknown) => error,
    );

    expect(isSandboxGoneError(error)).toBe(true);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "http://supervisor.test/computers/computer/exec",
      "http://supervisor.test/computers/computer",
    ]);
  });

  it("keeps an exec failure on a live container a failed command", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/exec")
          ? new Response("bad gateway", { status: 502 })
          : Response.json({ id: "computer", running: true }),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    const events = [];
    for await (const event of provider.execute(computer, { argv: ["true"] }, context)) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "stderr", data: "exec failed: 502" },
      { type: "exit", code: 1 },
    ]);
  });

  it("reports a stopped container gone when granting interactive control", async () => {
    supervisorWith(() => Response.json({ id: "computer", running: false }));
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    const error = await provider.setScreenControl(computer, true, context, "lease-1").then(
      () => null,
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(isSandboxGoneError(error)).toBe(true);
  });

  it("reports a stopped container gone instead of a blank screen", async () => {
    supervisorWith(() => Response.json({ id: "computer", running: false }));
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    const error = await provider
      .connectScreen(computer, { view: "stream", interactive: false }, context)
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(isSandboxGoneError(error)).toBe(true);
  });

  it("does not treat a supervisor lookup failure as a stopped container", async () => {
    // The supervisor answers 404 for any inspection error, not only a missing container.
    supervisorWith(() => Response.json({ error: "computer not found" }, { status: 404 }));
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(provider.setScreenControl(computer, false, context, "lease-1")).rejects.toThrow(
      /sandbox screen mode failed: 400/,
    );
    await expect(
      provider.connectScreen(computer, { view: "stream", interactive: false }, context),
    ).resolves.toMatchObject({ url: null });
  });

  it("propagates cancellation raised while checking the container", async () => {
    const controller = new AbortController();
    supervisorWith(() => {
      controller.abort();
      throw controller.signal.reason;
    });
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const cancelable = { ...context, signal: controller.signal };

    await expect(
      provider.setScreenControl(computer, false, cancelable, "lease-1"),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps a screen-mode failure on a live container an error", async () => {
    supervisorWith(() => Response.json({ id: "computer", running: true }));
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(provider.setScreenControl(computer, false, context, "lease-1")).rejects.toThrow(
      /sandbox screen mode failed: 400 .*is not running/,
    );
    await expect(
      provider.connectScreen(computer, { view: "stream", interactive: false }, context),
    ).resolves.toMatchObject({ url: null });
  });

  it("does not guess when the supervisor cannot describe the container", async () => {
    supervisorWith(() => new Response("upstream unavailable", { status: 502 }));
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(provider.setScreenControl(computer, false, context, "lease-1")).rejects.toThrow(
      /sandbox screen mode failed: 400/,
    );
    await expect(
      provider.connectScreen(computer, { view: "stream", interactive: false }, context),
    ).resolves.toMatchObject({ url: null });
  });
});
