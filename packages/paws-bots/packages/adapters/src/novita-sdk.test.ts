import type { DesktopSandbox, Novita } from "novita-sandbox";
import { SandboxNotFoundError, TimeoutError } from "novita-sandbox";
import { describe, expect, it, vi } from "vitest";
import { destroyNovitaComputer, novitaDesktop, pauseNovitaComputer } from "./novita-sandbox.js";

function fixture() {
  const handle = {
    wait: vi.fn(async () => ({ exitCode: 0, stdout: "done", stderr: "" })),
    kill: vi.fn(async () => true),
    disconnect: vi.fn(async () => undefined),
    stdout: "partial",
  };
  const source = {
    sandboxId: "test-computer",
    commands: { run: vi.fn(async () => handle) },
    files: {
      read: vi.fn(async () => new Uint8Array([1, 2, 3])),
      write: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      getInfo: vi.fn(async () => ({ size: 3 })),
    },
  };
  const pause = vi.fn(async () => undefined);
  const desktop = novitaDesktop(source as unknown as DesktopSandbox, pause);
  return { handle, source, desktop, pause };
}

describe("Novita SDK translation", () => {
  it("safety-pauses an uncertain command start even when no handle was received", async () => {
    const { desktop, source, pause, handle } = fixture();
    source.commands.run.mockRejectedValueOnce(new TimeoutError("start event timed out"));
    await expect(desktop.commands.run("side-effect", {})).rejects.toMatchObject({
      name: "SandboxUnsafeStopError",
    });
    expect(pause).toHaveBeenCalledOnce();
    expect(handle.kill).not.toHaveBeenCalled();
    expect(source.commands.run).toHaveBeenCalledOnce();
  });

  it("passes shell options and waits for the native command handle", async () => {
    const { desktop, source, handle } = fixture();
    const signal = new AbortController().signal;
    const options = { signal, timeoutMs: 42, cwd: "/workspace", envs: { NAME: "test" } };
    await expect(desktop.commands.run("echo test", options)).resolves.toEqual({
      exitCode: 0,
      stdout: "done",
      stderr: "",
    });
    expect(source.commands.run).toHaveBeenCalledWith("echo test", {
      background: true,
      timeoutMs: 42,
      cwd: "/workspace",
      envs: { NAME: "test" },
    });
    expect(handle.kill).not.toHaveBeenCalled();
  });

  it("does not start commands or file requests with an already-aborted signal", async () => {
    const { desktop, source } = fixture();
    const signal = AbortSignal.abort(new Error("canceled"));
    await expect(desktop.commands.run("side-effect", { signal })).rejects.toThrow("canceled");
    await expect(desktop.files.read("file", { format: "bytes", signal })).rejects.toThrow(
      "canceled",
    );
    await expect(
      desktop.files.write([{ path: "file", data: new ArrayBuffer(0) }], { signal }),
    ).rejects.toThrow("canceled");
    expect(source.commands.run).not.toHaveBeenCalled();
    expect(source.files.read).not.toHaveBeenCalled();
    expect(source.files.write).not.toHaveBeenCalled();
  });

  it("kills a command when canceled during execution and reports exit 130", async () => {
    const { desktop, handle } = fixture();
    const controller = new AbortController();
    let finish!: () => void;
    handle.wait.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ exitCode: 0, stdout: "done", stderr: "" });
        }),
    );
    handle.kill.mockImplementation(async () => {
      finish();
      return true;
    });
    const pending = desktop.commands.run("long-command", { signal: controller.signal });
    await vi.waitFor(() => expect(finish).toBeDefined());
    controller.abort();
    await expect(pending).resolves.toEqual({
      exitCode: 130,
      stdout: "partial",
      stderr: "command aborted\n",
    });
    expect(handle.kill).toHaveBeenCalledOnce();
  });

  it("kills a command canceled before the start response arrives", async () => {
    const { desktop, source, handle } = fixture();
    const controller = new AbortController();
    source.commands.run.mockImplementationOnce(async () => {
      controller.abort();
      return handle;
    });
    await expect(
      desktop.commands.run("long-command", { signal: controller.signal }),
    ).resolves.toMatchObject({ exitCode: 130 });
    expect(handle.kill).toHaveBeenCalledOnce();
  });

  it("surfaces a failed cancellation rather than claiming the remote process stopped", async () => {
    const { desktop, source, handle } = fixture();
    const controller = new AbortController();
    source.commands.run.mockImplementationOnce(async () => {
      controller.abort();
      return handle;
    });
    handle.kill.mockRejectedValue(new Error("kill unavailable"));
    await expect(
      desktop.commands.run("long-command", { signal: controller.signal }),
    ).rejects.toThrow("computer was paused");
  });

  it("terminates a command on a native deadline before returning the timeout", async () => {
    const { desktop, handle } = fixture();
    const deadline = new TimeoutError("deadline_exceeded: command timeout");
    handle.wait.mockRejectedValueOnce(deadline);
    await expect(desktop.commands.run("long-command", { timeoutMs: 42 })).rejects.toBe(deadline);
    expect(handle.kill).toHaveBeenCalledOnce();
    expect(handle.disconnect).toHaveBeenCalledOnce();
  });

  it("terminates a command after a broken stream without replaying it", async () => {
    const { desktop, handle, source } = fixture();
    const failure = new Error("connection reset");
    handle.wait.mockRejectedValueOnce(failure);
    await expect(desktop.commands.run("side-effect", {})).rejects.toBe(failure);
    expect(handle.kill).toHaveBeenCalledOnce();
    expect(source.commands.run).toHaveBeenCalledOnce();
  });

  it("retries a failed command kill without waiting for a stuck stream", async () => {
    const { desktop, handle, pause } = fixture();
    const controller = new AbortController();
    handle.wait.mockImplementation(() => new Promise(() => undefined));
    handle.kill.mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValueOnce(true);
    const pending = desktop.commands.run("long-command", { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ exitCode: 130 });
    expect(handle.kill).toHaveBeenCalledTimes(2);
    expect(pause).not.toHaveBeenCalled();
  });

  it("escalates repeated kill failures to pause even when the command stream never settles", async () => {
    const { desktop, handle, pause } = fixture();
    const controller = new AbortController();
    handle.wait.mockImplementation(() => new Promise(() => undefined));
    handle.kill.mockRejectedValue(new Error("kill unavailable"));
    const pending = desktop.commands.run("long-command", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("computer was paused");
    expect(handle.kill).toHaveBeenCalledTimes(3);
    expect(pause).toHaveBeenCalledOnce();
    expect(handle.disconnect).toHaveBeenCalledOnce();
  });

  it("reports an unconfirmed stop when both termination and pause fail", async () => {
    const { desktop, source, handle, pause } = fixture();
    const controller = new AbortController();
    source.commands.run.mockImplementationOnce(async () => {
      controller.abort();
      return handle;
    });
    handle.kill.mockRejectedValue(new Error("kill unavailable"));
    pause.mockRejectedValue(new Error("pause unavailable"));
    await expect(
      desktop.commands.run("long-command", { signal: controller.signal }),
    ).rejects.toThrow("may still be running");
    expect(handle.kill).toHaveBeenCalledTimes(3);
    expect(pause).toHaveBeenCalledOnce();
  });

  it("passes file bytes through the SDK without unsupported signal options", async () => {
    const { desktop, source } = fixture();
    const signal = new AbortController().signal;
    await expect(desktop.files.read("file", { format: "bytes", signal })).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(source.files.read).toHaveBeenCalledWith("file", { format: "bytes" });
  });
});

describe("Novita stop confirmation", () => {
  function control() {
    const sandbox = {
      pause: vi.fn(async () => true),
      getInfo: vi.fn(async () => ({ state: "paused" })),
      kill: vi.fn(),
    };
    return { sandbox, client: { sandbox } as unknown as Pick<Novita, "sandbox"> };
  }

  it("accepts a lost pause acknowledgement only after verifying paused state", async () => {
    const { client, sandbox } = control();
    sandbox.pause.mockRejectedValueOnce(new Error("response lost"));
    await expect(pauseNovitaComputer(client, "computer")).resolves.toBeUndefined();
    expect(sandbox.getInfo).toHaveBeenCalledWith("computer");
    expect(sandbox.pause).toHaveBeenCalledOnce();
    expect(sandbox.pause).toHaveBeenCalledWith("computer", { sync: true });
  });

  it("retries conflicting and still-running pause responses", async () => {
    const { client, sandbox } = control();
    sandbox.pause.mockResolvedValueOnce(false);
    sandbox.getInfo.mockResolvedValueOnce({ state: "running" });
    await pauseNovitaComputer(client, "computer");
    expect(sandbox.pause).toHaveBeenCalledTimes(2);
    expect(sandbox.getInfo).toHaveBeenCalledTimes(2);
  });

  it("fails after bounded retries without deleting saved data", async () => {
    const { client, sandbox } = control();
    sandbox.getInfo.mockResolvedValue({ state: "running" });
    await expect(pauseNovitaComputer(client, "computer")).rejects.toThrow("may still be running");
    expect(sandbox.pause).toHaveBeenCalledTimes(3);
    expect(sandbox.kill).not.toHaveBeenCalled();
  });

  it("treats an already deleted computer as stopped", async () => {
    const { client, sandbox } = control();
    sandbox.pause.mockRejectedValueOnce(new SandboxNotFoundError("gone"));
    await expect(pauseNovitaComputer(client, "computer")).resolves.toBeUndefined();
    expect(sandbox.getInfo).not.toHaveBeenCalled();
  });
});

describe("Novita destruction confirmation", () => {
  function control() {
    const sandbox = {
      kill: vi.fn(async () => true),
      getInfo: vi.fn(async () => ({ state: "paused" })),
      pause: vi.fn(async () => true),
    };
    return { sandbox, client: { sandbox } as unknown as Pick<Novita, "sandbox"> };
  }

  it("confirms deletion without resuming the computer", async () => {
    const { client, sandbox } = control();
    sandbox.getInfo.mockRejectedValueOnce(new SandboxNotFoundError("gone"));
    await expect(destroyNovitaComputer(client, "computer")).resolves.toBe(true);
    expect(sandbox.kill).toHaveBeenCalledOnce();
    expect(sandbox.pause).not.toHaveBeenCalled();
  });

  it("treats an already deleted computer as an idempotent success", async () => {
    const { client, sandbox } = control();
    sandbox.kill.mockResolvedValueOnce(false);
    await expect(destroyNovitaComputer(client, "computer")).resolves.toBe(false);
    expect(sandbox.getInfo).not.toHaveBeenCalled();
  });

  it("recognizes deletion after losing the response", async () => {
    const { client, sandbox } = control();
    sandbox.kill.mockRejectedValueOnce(new Error("response lost"));
    sandbox.getInfo.mockRejectedValueOnce(new SandboxNotFoundError("gone"));
    await expect(destroyNovitaComputer(client, "computer")).resolves.toBe(true);
    expect(sandbox.kill).toHaveBeenCalledOnce();
  });

  it("retries deletion then pauses a computer whose deletion remains unconfirmed", async () => {
    const { client, sandbox } = control();
    sandbox.kill.mockRejectedValue(new Error("delete unavailable"));
    await expect(destroyNovitaComputer(client, "computer")).rejects.toThrow("paused instead");
    expect(sandbox.kill).toHaveBeenCalledTimes(3);
    expect(sandbox.pause).toHaveBeenCalledOnce();
  });
});
