import { InstaboxError } from "@insforge/instabox-sdk";
import { describe, expect, it, vi } from "vitest";
import { INSTABOX_COMPUTER_TEMPLATE } from "./instabox-sandbox.js";
import { emulatedInstabox, InstaboxEmulator } from "./instabox-sandbox.test-support.js";
import { isSandboxGoneError } from "./sandbox-errors.js";
import { assertSandboxWorkspaceContract } from "./sandbox-test-support.js";

const ctx = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
};
const request = { botId: "bot", homePath: "/unused" };

async function started(emulator = new InstaboxEmulator()) {
  const { provider } = emulatedInstabox(emulator);
  const instabox = provider();
  const computer = await instabox.provision(request, ctx);
  await instabox.prepare(computer, ctx);
  return { emulator, provider: instabox, computer };
}

async function run(
  provider: Awaited<ReturnType<typeof started>>["provider"],
  computer: Awaited<ReturnType<typeof started>>["computer"],
  timeoutMs: number,
  context = ctx,
) {
  const events = [];
  for await (const event of provider.execute(
    computer,
    { argv: ["sleep", "infinity"], timeoutMs },
    context,
  ))
    events.push(event);
  return events;
}

describe("instabox computer backend", () => {
  it("starts a desktop computer with its home linked and its gateway published", async () => {
    const { emulator, provider, computer } = await started();
    expect(provider.describe()).toMatchObject({
      id: "instabox",
      capabilities: { graphical: true },
    });
    expect(provider.billsWhileRunning()).toBe(true);
    expect(computer).toMatchObject({ kind: "instabox", fresh: true });
    const machine = emulator.computers.get(computer.id)!;
    expect(machine.template).toBe(INSTABOX_COMPUTER_TEMPLATE);
    expect(machine.metadata).toMatchObject({ botId: "bot", rakazo: "computer" });
    expect(machine.published).toEqual(new Set([6100]));
    expect(emulator.commands[0]).toContain("ln -s");
    const screen = await provider.connectScreen(computer, { view: "stream" }, ctx);
    expect(new URL(screen.url!).host).toBe(`6100-${computer.id.slice(2)}.instabox.test`);
  });

  it("keeps the workspace contract", async () => {
    const { provider, computer } = await started();
    await assertSandboxWorkspaceContract(provider, computer, ctx);
  });

  it("lists names with spaces, and directories", async () => {
    const { emulator, provider, computer } = await started();
    await provider.writeFile(
      computer,
      { path: "notes/a b.txt", content: new TextEncoder().encode("hi") },
      ctx,
    );
    const { files } = emulator.computers.get(computer.id)!;
    files.set("/home/user/rakazo-home/notes/deep/x", { content: new Uint8Array(1), mode: 0o644 });
    expect(await provider.listFiles(computer, "notes", ctx)).toEqual([
      { path: "notes/a b.txt", kind: "file", size: 2 },
      { path: "notes/deep", kind: "dir", size: 4096 },
    ]);
  });

  it("pauses on stop, resumes on the next start, and deletes on destroy", async () => {
    const { emulator, provider, computer } = await started();
    await provider.stop(computer, ctx);
    expect(emulator.computers.get(computer.id)!.state).toBe("suspended");
    expect(await provider.isRunning(computer, ctx)).toBe(false);
    await provider.stop(computer, ctx);
    const resumed = await provider.provision(
      { ...request, providerRef: computer.id, providerKind: "instabox" },
      ctx,
    );
    expect(resumed).toMatchObject({ id: computer.id, fresh: false });
    expect(emulator.computers.get(computer.id)!.state).toBe("running");
    await provider.destroy(computer, ctx);
    expect(emulator.computers.has(computer.id)).toBe(false);
    await expect(provider.destroy(computer, ctx)).resolves.toBeUndefined();
    await expect(provider.stop(computer, ctx)).resolves.toBeUndefined();
  });

  it("replaces a deleted computer, but not one missing a file", async () => {
    const { emulator, provider, computer } = await started();
    await expect(provider.readFile(computer, "missing.txt", ctx)).rejects.toSatisfy(
      (error) => !isSandboxGoneError(error),
    );
    emulator.computers.delete(computer.id);
    await expect(provider.isRunning(computer, ctx)).resolves.toBe(false);
    const replaced = await provider.provision(
      { ...request, providerRef: computer.id, providerKind: "instabox" },
      ctx,
    );
    expect(replaced.id).not.toBe(computer.id);
    expect(replaced.fresh).toBe(true);
  });

  it("reports a rate limit as one", async () => {
    const emulator = new InstaboxEmulator();
    emulator.rateLimited = 1;
    const { provider } = emulatedInstabox(emulator);
    await expect(provider().provision(request, ctx)).rejects.toMatchObject({
      name: "SandboxRateLimitError",
    });
  });

  it("deletes a new computer whose setup failed", async () => {
    const emulator = new InstaboxEmulator();
    emulator.fails = (command) => command.includes("ln -s");
    const { provider } = emulatedInstabox(emulator);
    await expect(provider().provision(request, ctx)).rejects.toThrow("permission denied");
    expect(emulator.computers.size).toBe(0);
  });

  it("ends a command at its deadline with exit 124", async () => {
    const { emulator, provider, computer } = await started();
    emulator.hangs = (command) => command.includes("infinity");
    const events = await run(provider, computer, 50);
    expect(events.at(-1)).toEqual({ type: "exit", code: 124 });
    expect(emulator.killedJobs).toHaveLength(1);
    expect(emulator.computers.get(computer.id)!.state).toBe("running");
  });

  it("kills a cancelled command instead of only closing its stream", async () => {
    const { emulator, provider, computer } = await started();
    emulator.hangs = (command) => command.includes("infinity");
    const controller = new AbortController();
    const finished = run(provider, computer, 60_000, { ...ctx, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(emulator.requests).toContain(`run ${computer.id} background`);
    controller.abort();
    const events = await finished;
    expect(events.at(-1)).toEqual({ type: "exit", code: 130 });
    expect(emulator.killedJobs).toHaveLength(1);
    expect(emulator.requests.some((request) => request.startsWith("pause "))).toBe(false);
  });

  it("runs a command past ten minutes as a job, and kills it when the run is cancelled", async () => {
    const { emulator, provider, computer } = await started();
    emulator.hangs = (command) => command.includes("infinity");
    const controller = new AbortController();
    const finished = run(provider, computer, 11 * 60_000, { ...ctx, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(emulator.requests).toContain(`run ${computer.id} background`);
    controller.abort();
    const events = await finished;
    expect(events.at(-1)).toEqual({ type: "exit", code: 130 });
    expect(emulator.killedJobs).toHaveLength(1);
  });

  it("pauses the computer when a cancelled job's kill is rejected", async () => {
    const { emulator, provider, computer } = await started();
    emulator.hangs = (command) => command.includes("infinity");
    emulator.jobKill = () => new Error("kill unavailable");
    const controller = new AbortController();
    const finished = run(provider, computer, 60_000, { ...ctx, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(finished).rejects.toMatchObject({ name: "SandboxUnsafeStopError" });
    expect(emulator.killedJobs).toHaveLength(3);
    const fenceAt = emulator.requests.indexOf(`fence ${computer.id}`);
    const pauseAt = emulator.requests.indexOf(`pause ${computer.id}`);
    expect(fenceAt).toBeGreaterThanOrEqual(0);
    expect(pauseAt).toBeGreaterThan(fenceAt);
    expect(emulator.computers.get(computer.id)!.state).toBe("suspended");
  });

  it("keeps the computer running when a timed-out job had already exited", async () => {
    const { emulator, provider, computer } = await started();
    emulator.hangs = (command) => command.includes("infinity");
    emulator.jobKill = () => false;
    const events = await run(provider, computer, 50);
    expect(events.at(-1)).toEqual({ type: "exit", code: 124 });
    expect(emulator.killedJobs).toHaveLength(1);
    expect(emulator.computers.get(computer.id)!.state).toBe("running");
  });

  it("retries a job kill that fails once", async () => {
    const { emulator, provider, computer } = await started();
    emulator.hangs = (command) => command.includes("infinity");
    let attempts = 0;
    emulator.jobKill = () => {
      attempts += 1;
      return attempts === 1 ? new Error("temporary failure") : true;
    };
    const events = await run(provider, computer, 50);
    expect(events.at(-1)).toEqual({ type: "exit", code: 124 });
    expect(emulator.killedJobs).toHaveLength(2);
    expect(emulator.computers.get(computer.id)!.state).toBe("running");
  });

  it("reports a computer deleted during a command as gone", async () => {
    const { emulator, provider, computer } = await started();
    emulator.computers.delete(computer.id);
    await expect(run(provider, computer, 1_000)).rejects.toSatisfy(isSandboxGoneError);
  });

  it("keeps the computer when a liveness check is rate limited", async () => {
    vi.useFakeTimers();
    try {
      const { emulator, provider, computer } = await started();
      const connects = emulator.requests.filter((request) => request.startsWith("connect "));
      emulator.rateLimited = 1;
      await vi.advanceTimersByTimeAsync(61_000);
      await expect(provider.listFiles(computer, "", ctx)).resolves.toEqual([]);
      expect(emulator.requests.filter((request) => request.startsWith("connect "))).toEqual(
        connects,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("instabox computer sizes", () => {
  const sizeOf = (emulator: InstaboxEmulator, id: string) => emulator.computers.get(id)!.spec;

  it("starts a new computer at the plan's size, leaving standard to instabox's default", async () => {
    const emulator = new InstaboxEmulator();
    const provider = emulatedInstabox(emulator).provider();
    const large = await provider.provision({ ...request, size: "large" }, ctx);
    const standard = await provider.provision({ ...request, size: "standard" }, ctx);
    expect(sizeOf(emulator, large.id)).toEqual({ vcpus: 8, memMiB: 16384 });
    expect(sizeOf(emulator, standard.id)).toEqual({ vcpus: 4, memMiB: 8192 });
    expect(emulator.requests.filter((name) => name.startsWith("create "))).toEqual([
      "create agent-browser 8/16384",
      "create agent-browser",
    ]);
  });

  it("reports a size the account's plan does not offer as unavailable", async () => {
    const emulator = new InstaboxEmulator();
    emulator.allowedSpecs = ["4/8192"];
    const provider = emulatedInstabox(emulator).provider();
    await expect(provider.provision({ ...request, size: "large" }, ctx)).rejects.toMatchObject({
      name: "SandboxSizeUnavailableError",
      reason: "not_offered",
    });
    expect(emulator.computers.size).toBe(0);
  });

  it("moves a stopped computer to the plan's size when it starts again", async () => {
    const { emulator, provider, computer } = await started();
    await provider.stop(computer, ctx);
    const resumed = await provider.provision(
      { ...request, providerRef: computer.id, providerKind: "instabox", size: "large" },
      ctx,
    );
    expect(resumed).toMatchObject({ id: computer.id, fresh: false });
    expect(sizeOf(emulator, computer.id)).toEqual({ vcpus: 8, memMiB: 16384 });
    expect(emulator.computers.get(computer.id)!.state).toBe("running");
  });

  it("keeps a running computer at the size it has", async () => {
    const { emulator, provider, computer } = await started();
    await provider.provision(
      { ...request, providerRef: computer.id, providerKind: "instabox", size: "large" },
      ctx,
    );
    expect(emulator.requests.some((name) => name.startsWith("resize "))).toBe(false);
    expect(sizeOf(emulator, computer.id)).toEqual({ vcpus: 4, memMiB: 8192 });
  });

  it("reports a computer that could not start at the new size as unavailable, at its old size", async () => {
    const { emulator, provider, computer } = await started();
    emulator.resizeFails = true;
    await provider.stop(computer, ctx);
    const reconnect = { ...request, providerRef: computer.id, providerKind: "instabox" as const };
    await expect(provider.provision({ ...reconnect, size: "large" }, ctx)).rejects.toMatchObject({
      name: "SandboxSizeUnavailableError",
    });
    expect(sizeOf(emulator, computer.id)).toEqual({ vcpus: 4, memMiB: 8192 });
    // The lifecycle then starts it at the size it has.
    await expect(provider.provision(reconnect, ctx)).resolves.toMatchObject({ fresh: false });
  });

  it("surfaces a resize failure that is not about the size instead of falling back", async () => {
    const { emulator, provider, computer } = await started();
    await provider.stop(computer, ctx);
    const outage = new InstaboxError("upstream unavailable", { status: 503, code: "unavailable" });
    emulator.resizeError = outage;
    const reconnect = { ...request, providerRef: computer.id, providerKind: "instabox" as const };
    await expect(provider.provision({ ...reconnect, size: "large" }, ctx)).rejects.toBe(outage);
  });
});
