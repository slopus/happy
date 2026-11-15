import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Exec, V1Pod } from "@kubernetes/client-node";
import type { AdapterContext, ComputerRef, ProcessEvent } from "@rakazo/adapter-kit";
import { shellQuote } from "@rakazo/core/node/desktop-runtime";
import { describe, expect, it, vi } from "vitest";
import { encodeTarEntry, TarReader } from "./exec-computer.js";
import type { KubernetesSandboxSdk } from "./kubernetes-sandbox.js";
import { KubernetesSandboxProvider } from "./kubernetes-sandbox.js";
import { isSandboxGoneError } from "./sandbox-errors.js";
import { assertSandboxWorkspaceContract, provisionPrepared } from "./sandbox-test-support.js";

const TAR_END = Buffer.alloc(1024);

/** Native `AbortSignal.timeout` ignores fake timers. */
function fakeRequestDeadline() {
  return vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("request deadline")), ms);
    return controller.signal;
  });
}

const context: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

const readyPod: V1Pod = {
  metadata: { name: "pod", labels: { "rakazo-bot-id": "bot-a" } },
  status: {
    phase: "Running",
    podIP: "10.0.0.8",
    conditions: [{ type: "Ready", status: "True" }],
  },
};

function providerFor(
  core: Partial<KubernetesSandboxSdk["core"]> = {},
  exec: KubernetesSandboxSdk["exec"]["exec"] = vi.fn(),
  options: ConstructorParameters<typeof KubernetesSandboxProvider>[0] = {},
) {
  return new KubernetesSandboxProvider(options, {
    core: {
      readNamespacedPod: vi.fn().mockResolvedValue(readyPod),
      createNamespacedPod: vi.fn().mockResolvedValue(readyPod),
      deleteNamespacedPod: vi.fn().mockResolvedValue({ status: "Success" }),
      ...core,
    },
    exec: { exec },
  } as unknown as KubernetesSandboxSdk);
}

const computer: ComputerRef = {
  id: "pod",
  botId: "bot-a",
  kind: "kubernetes",
  providerRef: "pod",
};

function successfulExec(stdoutText = "", stderrText = "", code = 0) {
  return vi.fn(async (...args: Parameters<Exec["exec"]>) => {
    const stdout = args[4];
    const stderr = args[5];
    const status = args[8];
    queueMicrotask(() => {
      if (stdoutText) stdout?.write(Buffer.from(stdoutText));
      if (stderrText) stderr?.write(Buffer.from(stderrText));
      status?.({
        status: code === 0 ? "Success" : "Failure",
        details: { causes: [{ reason: "ExitCode", message: String(code) }] },
      });
    });
    return { close: vi.fn(), onclose: null, onerror: null } as unknown as Awaited<
      ReturnType<Exec["exec"]>
    >;
  });
}

describe("KubernetesSandboxProvider", () => {
  it("passes the shared offline sandbox workspace contract", async () => {
    const files = new Map<string, { content: Buffer; executable: boolean }>();
    let exportedNames: string[] = [];
    const exec = vi.fn(async (...args: Parameters<Exec["exec"]>) => {
      const command = args[3];
      if (!Array.isArray(command)) throw new Error("expected argv");
      const stdout = args[4];
      const stdin = args[6];
      const finish = () => args[8]?.({ status: "Success" });
      if (stdin) {
        const chunks: Buffer[] = [];
        stdin.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        stdin.on("end", () => {
          const content = Buffer.concat(chunks);
          const write = command.indexOf("rakazo-write");
          if (write >= 0) {
            files.set(command[write + 1]!, {
              content,
              executable: command[write + 2] === "700",
            });
          } else {
            expect(command).toContain("rakazo-export-list");
            exportedNames = content.toString().split("\0").filter(Boolean);
          }
          finish();
        });
      } else {
        queueMicrotask(() => {
          if (command.includes("echo")) stdout?.write("graphical-ok\n");
          else if (command.includes("stat"))
            stdout?.write(String(files.get(command.at(-1)!)!.content.length));
          else if (command.includes("cat")) stdout?.write(files.get(command.at(-1)!)!.content);
          else if (
            command.includes("find") ||
            command.some((arg) => arg.includes("find . -regextype"))
          ) {
            const directory = command.includes("find")
              ? command[command.indexOf("find") + 1]!
              : "/home/rakazo";
            for (const [name, file] of files) {
              const relative = name.slice(directory.length + 1);
              if (!name.startsWith(`${directory}/`)) continue;
              if (command.includes("-maxdepth")) {
                if (relative.includes("/")) continue;
                stdout?.write(
                  `${relative}\0f\0${file.content.length}\0${file.executable ? "700" : "600"}\0`,
                );
              } else stdout?.write(`${relative}\0`);
            }
          } else if (command.includes("tar")) {
            for (const name of exportedNames) {
              const file = files.get(`/home/rakazo/${name}`)!;
              for (const chunk of encodeTarEntry(name, file.content, file.executable))
                stdout?.write(chunk);
            }
            stdout?.write(TAR_END);
          } else if (command.some((arg) => arg.includes("RAKAZO_DESKTOP=")))
            stdout?.write("RAKAZO_DESKTOP=0:offline-view-token\n");
          else if (command.some((arg) => arg.includes("getmouselocation")))
            stdout?.write("cG5n\nCURSOR X=1 Y=2\n");
          finish();
        });
      }
      return { close: vi.fn(), onclose: null, onerror: null } as unknown as Awaited<
        ReturnType<Exec["exec"]>
      >;
    });
    const provider = providerFor({}, exec);
    const provisioned = await provisionPrepared(
      provider,
      { botId: "bot-a", homePath: "/unused" },
      context,
    );
    await assertSandboxWorkspaceContract(provider, provisioned, context);
    await provider.destroy(provisioned, context);
  });

  describe("when the exec connection is refused", () => {
    class SocketErrorEvent {
      readonly #status: number;
      constructor(status: number) {
        this.#status = status;
      }
      get error() {
        return new Error(`Unexpected server response: ${this.#status}`);
      }
    }

    it("keeps the reason", async () => {
      expect(JSON.stringify(new SocketErrorEvent(503))).toBe("{}");
      const failure = await providerFor({}, vi.fn().mockRejectedValue(new SocketErrorEvent(503)))
        .prepare(computer, context)
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ message: "Unexpected server response: 503" });
      expect(isSandboxGoneError(failure)).toBe(false);
    });

    it.each([
      ["missing", undefined],
      ["failed", { status: { phase: "Failed" } }],
      ["succeeded", { status: { phase: "Succeeded" } }],
      ["deleting", { ...readyPod, metadata: { deletionTimestamp: new Date() } }],
    ])("reports a %s pod as a computer that is gone", async (_state, pod) => {
      const reason = new Error("Unexpected server response: 404");
      const readNamespacedPod = pod
        ? vi.fn().mockResolvedValue(pod)
        : vi.fn().mockRejectedValue(Object.assign(new Error("missing"), { code: 404 }));
      const failure = await providerFor(
        { readNamespacedPod },
        vi.fn().mockRejectedValue({ error: reason }),
      )
        .prepare(computer, context)
        .catch((error: unknown) => error);

      expect(isSandboxGoneError(failure)).toBe(true);
      expect(failure).toMatchObject({ message: "Kubernetes computer pod no longer exists" });
      expect((failure as Error).cause).toBe(reason);
      expect(readNamespacedPod).toHaveBeenCalledWith(
        { name: "pod", namespace: "rakazo-sandboxes" },
        expect.anything(),
      );
    });

    it.each(["running", "read fails"])(
      "keeps the original 404 when the pod is %s",
      async (state) => {
        const reason = new Error("Unexpected server response: 404");
        const readNamespacedPod =
          state === "running"
            ? vi.fn().mockResolvedValue(readyPod)
            : vi.fn().mockRejectedValue(new Error("API unavailable"));
        const failure = await providerFor(
          { readNamespacedPod },
          vi.fn().mockRejectedValue({ error: reason }),
        )
          .prepare(computer, context)
          .catch((error: unknown) => error);

        expect(failure).toBe(reason);
        expect(isSandboxGoneError(failure)).toBe(false);
      },
    );
  });

  it("validates the immutable computer image without package installation", async () => {
    const exec = successfulExec();
    const provider = providerFor({}, exec);

    await provider.prepare(computer, context);

    const command = exec.mock.calls[0]?.[3];
    expect(command).toEqual([
      "timeout",
      "--signal=TERM",
      "--kill-after=5s",
      "300s",
      "bash",
      "-c",
      expect.any(String),
    ]);
    const script = command?.[6] ?? "";
    expect(script).not.toContain("sudo");
    expect(script).not.toContain("apt-get");
    expect(script).toContain("command -v scrot");
    expect(script).toContain("command -v import");
    expect(script).toContain("computer image is missing required desktop tools");
  });

  it("creates a ready pod with required isolation metadata", async () => {
    const readNamespacedPod = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: 404 }))
      .mockResolvedValue(readyPod);
    const createNamespacedPod = vi.fn().mockResolvedValue(readyPod);
    const deleteNamespacedPod = vi.fn().mockResolvedValue({ status: "Success" });
    const provider = new KubernetesSandboxProvider(
      {
        namespace: "sandboxes",
        runtimeClassName: "gvisor",
        computerImage: "registry.example.test/computer:v1",
        cpuLimit: "2",
        memoryLimit: "4Gi",
        podAnnotations: { "example.test/policy": "sandbox" },
        podLabels: { "example.test/tier": "computer" },
      },
      {
        core: { readNamespacedPod, createNamespacedPod, deleteNamespacedPod },
        exec: { exec: vi.fn() },
      } as unknown as KubernetesSandboxSdk,
    );

    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);

    expect(computer).toMatchObject({ kind: "kubernetes", botId: "bot-a", fresh: true });
    expect(createNamespacedPod).toHaveBeenCalledOnce();
    const request = createNamespacedPod.mock.calls[0]?.[0];
    expect(request?.namespace).toBe("sandboxes");
    expect(request?.body).toMatchObject({
      metadata: {
        annotations: { "example.test/policy": "sandbox" },
        labels: {
          "app.kubernetes.io/name": "rakazo-computer",
          "example.test/tier": "computer",
          "rakazo-bot-id": "bot-a",
        },
      },
      spec: {
        automountServiceAccountToken: false,
        runtimeClassName: "gvisor",
        containers: [
          {
            image: "registry.example.test/computer:v1",
            resources: { limits: { cpu: "2", memory: "4Gi" } },
          },
        ],
      },
    });
    await expect(provider.isRunning(computer, context)).resolves.toBe(true);
    await provider.destroy(computer, context);
    expect(deleteNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ name: computer.providerRef, namespace: "sandboxes" }),
      expect.anything(),
    );
  });

  it("streams stdout and stderr and preserves the remote exit code", async () => {
    const exec = vi.fn(async (...args: Parameters<Exec["exec"]>) => {
      const stdout = args[4];
      const stderr = args[5];
      const status = args[8];
      queueMicrotask(() => {
        stdout?.write(Buffer.from("out"));
        stderr?.write(Buffer.from("err"));
        status?.({
          status: "Failure",
          details: { causes: [{ reason: "ExitCode", message: "7" }] },
        });
      });
      return {
        close: vi.fn(),
        onclose: null,
        onerror: null,
      } as unknown as Awaited<ReturnType<Exec["exec"]>>;
    });
    const provider = new KubernetesSandboxProvider(
      {},
      {
        core: {} as KubernetesSandboxSdk["core"],
        exec: { exec },
      },
    );
    const computer: ComputerRef = {
      id: "pod",
      botId: "bot-a",
      kind: "kubernetes",
      providerRef: "pod",
    };
    const events: ProcessEvent[] = [];

    for await (const event of provider.execute(
      computer,
      { argv: ["printf", "done"], env: { TEST_VALUE: "value" }, unsetEnv: ["OLD_VALUE"] },
      context,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "stdout", data: "out" },
      { type: "stderr", data: "err" },
      { type: "exit", code: 7 },
    ]);
    expect(exec).toHaveBeenCalledWith(
      "rakazo-sandboxes",
      "pod",
      "computer",
      expect.arrayContaining(["TEST_VALUE=value", "OLD_VALUE", "printf", "done"]),
      expect.anything(),
      expect.anything(),
      null,
      false,
      expect.any(Function),
    );
  });

  it("attaches the controlled terminal without replacing the bot run screen fence", async () => {
    const exec = successfulExec("RAKAZO_DESKTOP=0:view-token\n");
    const provider = providerFor({}, exec);

    await provider.connectTerminal(
      computer,
      { controlToken: "control-token", cwd: "" },
      { ...context, botId: "bot-a", screenLeaseId: "run-id:7" },
    );

    const commands = exec.mock.calls
      .map((call) => (Array.isArray(call[3]) ? call[3].join(" ") : call[3]))
      .join("\n");
    expect(commands).toContain("control-token");
    expect(commands).not.toContain("run-id:7");
  });

  it("reconnects to an existing ready pod without creating it", async () => {
    const create = vi.fn();
    const provider = providerFor({
      readNamespacedPod: vi.fn().mockResolvedValue(readyPod),
      createNamespacedPod: create,
    });
    const result = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    expect(result.fresh).toBe(false);
    expect(result.providerRef).toMatch(/^rakazo-bot-a-/);
    expect(create).not.toHaveBeenCalled();
  });

  it("handles a create conflict by reconnecting to the matching pod", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: 404 }))
      .mockResolvedValue(readyPod);
    const create = vi.fn().mockRejectedValue(Object.assign(new Error("conflict"), { code: 409 }));
    const provider = providerFor({ readNamespacedPod: read, createNamespacedPod: create });
    await expect(
      provider.provision({ botId: "bot-a", homePath: "/unused" }, context),
    ).resolves.toMatchObject({ fresh: false });
  });

  it("rejects a create conflict when the winner belongs to another bot", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: 404 }))
      .mockResolvedValue({ ...readyPod, metadata: { labels: { "rakazo-bot-id": "bot-b" } } });
    const create = vi.fn().mockRejectedValue(Object.assign(new Error("conflict"), { code: 409 }));
    const provider = providerFor({ readNamespacedPod: read, createNamespacedPod: create });
    await expect(
      provider.provision({ botId: "bot-a", homePath: "/unused" }, context),
    ).rejects.toThrow("belongs to another bot");
  });

  describe("mounted home", () => {
    const home = {
      homeClaim: "data-claim",
      homeColocateNamespace: "rakazo",
      homeColocateLabels: { app: "rakazo-api" },
    };

    it("mounts only the bot's home directory and pins the pod beside the volume", async () => {
      const create = vi.fn().mockResolvedValue(readyPod);
      const provider = providerFor(
        {
          readNamespacedPod: vi
            .fn()
            .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: 404 }))
            .mockResolvedValue(readyPod),
          createNamespacedPod: create,
        },
        vi.fn(),
        home,
      );
      await provider.provision({ botId: "team-ab12", homePath: "/data/homes/team-ab12" }, context);
      expect(create.mock.calls[0]?.[0]?.body.spec).toMatchObject({
        volumes: [{ name: "home", persistentVolumeClaim: { claimName: "data-claim" } }],
        securityContext: { fsGroup: 1000 },
        affinity: {
          podAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: [
              {
                namespaces: ["rakazo"],
                labelSelector: { matchLabels: { app: "rakazo-api" } },
                topologyKey: "kubernetes.io/hostname",
              },
            ],
          },
        },
        containers: [
          {
            volumeMounts: [{ name: "home", mountPath: "/home/rakazo", subPath: "homes/team-ab12" }],
          },
        ],
      });
      expect(provider.describe().capabilities.persistentHome).toBe(true);
    });

    it("refuses a bot id that is not a single folder name", async () => {
      const provider = providerFor(
        {
          readNamespacedPod: vi
            .fn()
            .mockRejectedValue(Object.assign(new Error("x"), { code: 404 })),
        },
        vi.fn(),
        home,
      );
      await expect(
        provider.provision({ botId: "../other", homePath: "/unused" }, context),
      ).rejects.toThrow("invalid bot id");
    });

    it("keeps an unmounted live pod saving until its normal stop", async () => {
      const legacy = { ...readyPod, spec: { volumes: [] } } as unknown as V1Pod;
      const del = vi.fn();
      const create = vi.fn();
      const provider = providerFor(
        {
          readNamespacedPod: vi.fn().mockResolvedValue(legacy),
          deleteNamespacedPod: del,
          createNamespacedPod: create,
        },
        vi.fn(),
        home,
      );
      await expect(provider.isRunning(computer, context)).resolves.toBe(true);
      await expect(provider.hasMountedHome(computer, context)).resolves.toBe(false);
      await expect(
        provider.provision(
          { botId: "bot-a", homePath: "/unused", providerKind: "kubernetes", providerRef: "pod" },
          context,
        ),
      ).resolves.toMatchObject({ fresh: false });
      expect(del).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });

    it.each(["correct", "missing-mount", "wrong-path", "wrong-home"])(
      "checks the actual home mount (%s)",
      async (kind) => {
        const pod = {
          ...readyPod,
          spec: {
            volumes: [{ name: "home", persistentVolumeClaim: { claimName: "data-claim" } }],
            containers: [
              {
                name: "computer",
                volumeMounts:
                  kind === "missing-mount"
                    ? []
                    : [
                        {
                          name: "home",
                          mountPath: kind === "wrong-path" ? "/other" : "/home/rakazo",
                          subPath: kind === "wrong-home" ? "homes/other" : "homes/bot-a",
                        },
                      ],
              },
            ],
          },
        } as V1Pod;
        await expect(
          providerFor(
            { readNamespacedPod: vi.fn().mockResolvedValue(pod) },
            vi.fn(),
            home,
          ).hasMountedHome(computer, context),
        ).resolves.toBe(kind === "correct");
      },
    );

    it("does not treat another claim as the configured home", async () => {
      const pod = {
        ...readyPod,
        spec: {
          volumes: [{ name: "home", persistentVolumeClaim: { claimName: "old-claim" } }],
          containers: [
            {
              name: "computer",
              volumeMounts: [{ name: "home", mountPath: "/home/rakazo", subPath: "homes/bot-a" }],
            },
          ],
        },
      } as V1Pod;
      await expect(
        providerFor(
          { readNamespacedPod: vi.fn().mockResolvedValue(pod) },
          vi.fn(),
          home,
        ).hasMountedHome(computer, context),
      ).resolves.toBe(false);
    });

    it("still sees a mounted home after the claim is removed from the configuration", async () => {
      const pod = {
        ...readyPod,
        spec: {
          volumes: [{ name: "home", persistentVolumeClaim: { claimName: "data-claim" } }],
          containers: [
            {
              name: "computer",
              volumeMounts: [{ name: "home", mountPath: "/home/rakazo", subPath: "homes/bot-a" }],
            },
          ],
        },
      } as V1Pod;
      await expect(
        providerFor({ readNamespacedPod: vi.fn().mockResolvedValue(pod) }).hasMountedHome(
          computer,
          context,
        ),
      ).resolves.toBe(true);
    });

    it("keeps a running pod that already mounts the home", async () => {
      const mounted = {
        ...readyPod,
        spec: { volumes: [{ name: "home", persistentVolumeClaim: { claimName: "data-claim" } }] },
      } as unknown as V1Pod;
      const del = vi.fn();
      const create = vi.fn();
      const result = await providerFor(
        {
          readNamespacedPod: vi.fn().mockResolvedValue(mounted),
          deleteNamespacedPod: del,
          createNamespacedPod: create,
        },
        vi.fn(),
        home,
      ).provision(
        { botId: "bot-a", homePath: "/unused", providerKind: "kubernetes", providerRef: "pod" },
        context,
      );
      expect(del).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(result.fresh).toBe(false);
    });

    it("requires the pod-affinity target", () => {
      expect(() => new KubernetesSandboxProvider({ homeClaim: "data-claim" })).toThrow(
        "pod-affinity",
      );
    });
  });

  it("rejects a pod carrying another bot's label", async () => {
    const provider = providerFor({
      readNamespacedPod: vi
        .fn()
        .mockResolvedValue({ ...readyPod, metadata: { labels: { "rakazo-bot-id": "bot-b" } } }),
    });
    await expect(
      provider.provision(
        { botId: "bot-a", homePath: "/unused", providerKind: "kubernetes", providerRef: "pod" },
        context,
      ),
    ).rejects.toThrow("belongs to another bot");
  });

  it.each(["Failed", "Succeeded"])(
    "deletes terminal %s pods before provisioning",
    async (phase) => {
      const terminal = { ...readyPod, status: { phase } } as V1Pod;
      const read = vi
        .fn()
        .mockResolvedValueOnce(terminal)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue(readyPod);
      const del = vi.fn().mockResolvedValue({ status: "Success" });
      const create = vi.fn().mockResolvedValue(readyPod);
      const provider = providerFor({
        readNamespacedPod: read,
        deleteNamespacedPod: del,
        createNamespacedPod: create,
      });
      await provider.provision(
        { botId: "bot-a", homePath: "/unused", providerKind: "kubernetes", providerRef: "pod" },
        context,
      );
      expect(del).toHaveBeenCalledWith(
        expect.objectContaining({ gracePeriodSeconds: 0 }),
        expect.anything(),
      );
      expect(create).toHaveBeenCalledOnce();
    },
  );

  it("times out readiness and deletes a newly created pod", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: 404 }))
      .mockResolvedValue({ ...readyPod, status: { phase: "Pending" } });
    const del = vi.fn().mockResolvedValue({ status: "Success" });
    const provider = providerFor({ readNamespacedPod: read, deleteNamespacedPod: del }, vi.fn(), {
      readyTimeoutMs: 1,
    });
    await expect(
      provider.provision({ botId: "bot-a", homePath: "/unused" }, context),
    ).rejects.toThrow("did not become ready");
    expect(del).toHaveBeenCalledOnce();
  });

  it("rejects when a pod disappears while waiting for readiness", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: 404 }))
      .mockRejectedValue(Object.assign(new Error("gone"), { code: 404 }));
    const del = vi.fn();
    const provider = providerFor({ readNamespacedPod: read, deleteNamespacedPod: del });
    await expect(
      provider.provision({ botId: "bot-a", homePath: "/unused" }, context),
    ).rejects.toThrow("disappeared while starting");
    expect(del).toHaveBeenCalledOnce();
  });

  it("uses the requested pod security and lifecycle fields", async () => {
    const create = vi.fn().mockResolvedValue(readyPod);
    const read = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: 404 }))
      .mockResolvedValue(readyPod);
    const provider = providerFor({ createNamespacedPod: create, readNamespacedPod: read });
    await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    const spec = create.mock.calls[0]?.[0].body?.spec;
    expect(spec).toMatchObject({
      automountServiceAccountToken: false,
      restartPolicy: "Never",
    });
    expect(spec?.containers[0]?.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      seccompProfile: { type: "RuntimeDefault" },
    });
  });

  it("parses split UTF-8 output and preserves separate streams", async () => {
    const exec = vi.fn(async (...args: Parameters<Exec["exec"]>) => {
      const out = args[4];
      const err = args[5];
      const status = args[8];
      queueMicrotask(() => {
        out?.write(Buffer.from([0xe2]));
        err?.write(Buffer.from("err-"));
        out?.write(Buffer.from([0x82, 0xac]));
        err?.write(Buffer.from("tail"));
        status?.({ status: "Success" });
      });
      return { close: vi.fn(), onclose: null, onerror: null } as unknown as Awaited<
        ReturnType<Exec["exec"]>
      >;
    });
    const events = [];
    for await (const event of providerFor({}, exec).execute(computer, { argv: ["true"] }, context))
      events.push(event);
    expect(
      events
        .filter((event) => event.type === "stdout")
        .map((event) => event.data)
        .join(""),
    ).toBe("€");
    expect(
      events
        .filter((event) => event.type === "stderr")
        .map((event) => event.data)
        .join(""),
    ).toBe("err-tail");
    expect(events.at(-1)).toEqual({ type: "exit", code: 0 });
  });

  it("falls back to exit code 1 when Kubernetes omits an exit code", async () => {
    const exec = vi.fn(async (...args: Parameters<Exec["exec"]>) => {
      queueMicrotask(() => args[8]?.({ status: "Failure" }));
      return { close: vi.fn(), onclose: null, onerror: null } as unknown as Awaited<
        ReturnType<Exec["exec"]>
      >;
    });
    const events = [];
    for await (const event of providerFor({}, exec).execute(computer, { argv: ["false"] }, context))
      events.push(event);
    expect(events.at(-1)).toEqual({ type: "exit", code: 1 });
  });

  it("preserves the timeout command's 124 exit fallback", async () => {
    const events = [];
    for await (const event of providerFor({}, successfulExec("", "timed out", 124)).execute(
      computer,
      { argv: ["sleep", "10"], timeoutMs: 1_000 },
      context,
    ))
      events.push(event);
    expect(events.at(-1)).toEqual({ type: "exit", code: 124 });
  });

  it("rejects Kubernetes exec socket errors", async () => {
    const exec = vi.fn(async () => {
      const socket = {
        close: vi.fn(),
        onclose: null as (() => void) | null,
        onerror: null as ((event: { error: Error }) => void) | null,
      };
      setTimeout(() => socket.onerror?.({ error: new Error("socket broke") }), 0);
      return socket as unknown as Awaited<ReturnType<Exec["exec"]>>;
    });
    const iterator = providerFor({}, exec)
      .execute(computer, { argv: ["true"] }, context)
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("socket broke");
  });

  it("cancels immediately with stderr and exit code 130", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = [];
    for await (const event of providerFor().execute(
      computer,
      { argv: ["sleep", "10"] },
      { ...context, signal: controller.signal },
    ))
      events.push(event);
    expect(events).toEqual([
      { type: "stderr", data: "command aborted\n" },
      { type: "exit", code: 130 },
    ]);
  });

  it("normalizes working directories, validates env names, and wraps timeouts", async () => {
    const exec = successfulExec();
    const provider = providerFor({}, exec);
    for await (const _event of provider.execute(
      computer,
      { argv: ["printf", "x"], cwd: "nested/dir", env: { OK_1: "yes" }, timeoutMs: 2_000 },
      context,
    )) {
      /* consume */
    }
    const command = exec.mock.calls[0]?.[3];
    expect(command).toContain("/home/rakazo/nested/dir");
    expect(command).toContain("OK_1=yes");
    expect(command).toContain("2s");
    const invalid = provider
      .execute(computer, { argv: ["true"], env: { "BAD-NAME": "no" } }, context)
      [Symbol.asyncIterator]();
    await expect(invalid.next()).rejects.toThrow("invalid environment name");
  });

  it("passes TTY mode and leaves stderr detached", async () => {
    const exec = successfulExec("terminal");
    const events = [];
    for await (const event of providerFor({}, exec).execute(
      computer,
      { argv: ["tty"], pty: true },
      context,
    ))
      events.push(event);
    expect(exec.mock.calls[0]?.[5]).toBeNull();
    expect(exec.mock.calls[0]?.[7]).toBe(true);
    expect(events).toContainEqual({ type: "stdout", data: "terminal" });
    expect(events.some((event) => event.type === "stderr")).toBe(false);
  });

  it("lists files with kinds, executable flags, and sorting", async () => {
    const exec = successfulExec(
      ["z", "f", "2", "644", "folder", "d", "0", "755", "a", "f", "1", "755", ""].join("\0"),
    );
    const result = await providerFor({}, exec).listFiles(computer, "", context);
    expect(result.map(({ path, kind, executable }) => ({ path, kind, executable }))).toEqual([
      { path: "a", kind: "file", executable: true },
      { path: "folder", kind: "dir", executable: undefined },
      { path: "z", kind: "file", executable: undefined },
    ]);
  });

  it("rejects list errors", async () => {
    await expect(
      providerFor({}, successfulExec("", "find failed", 2)).listFiles(computer, "", context),
    ).rejects.toThrow("find failed");
  });

  it("checks file size before cat and streams file contents", async () => {
    const exec = vi.fn(async (...args: Parameters<Exec["exec"]>) => {
      const command = args[3];
      const out = args[4];
      const status = args[8];
      queueMicrotask(() => {
        out?.write(command.includes("stat") ? "3" : "abc");
        status?.({ status: "Success" });
      });
      return { close: vi.fn(), onclose: null, onerror: null } as unknown as Awaited<
        ReturnType<Exec["exec"]>
      >;
    });
    const provider = providerFor({}, exec);
    await expect(provider.readFile(computer, "f", context, { maxBytes: 2 })).rejects.toThrow(
      "exceeds 2 bytes",
    );
    expect(exec).toHaveBeenCalledOnce();
    await expect(provider.readFile(computer, "f", context)).resolves.toEqual(
      new Uint8Array(Buffer.from("abc")),
    );
  });

  it("writes files atomically with executable and regular permissions", async () => {
    const exec = successfulExec();
    const provider = providerFor({}, exec);
    await provider.writeFile(
      computer,
      { path: "bin/tool", content: Buffer.from("x"), executable: true },
      context,
    );
    expect(String(exec.mock.calls[0]?.[3])).toContain('mv -f -- "$temporary" "$target"');
    expect(String(exec.mock.calls[0]?.[3])).toContain("700");
    await provider.writeFile(computer, { path: "data", content: Buffer.from("x") }, context);
    expect(String(exec.mock.calls[1]?.[3])).toContain("600");
  });

  it("propagates write failures", async () => {
    await expect(
      providerFor({}, successfulExec("", "write denied", 1)).writeFile(
        computer,
        { path: "data", content: Buffer.from("x") },
        context,
      ),
    ).rejects.toThrow("write denied");
  });

  it("exports binary files without attaching stdin to the archive exec", async () => {
    const binary = Buffer.alloc(2 * 1024 * 1024, 0xa5);
    const staged: Buffer[] = [];
    const commands: string[][] = [];
    const archive = Buffer.concat([
      ...encodeTarEntry("a.txt", binary),
      ...encodeTarEntry("run.sh", Buffer.from("#!"), true),
      TAR_END,
    ]);
    const exec = vi.fn(async (...args: Parameters<Exec["exec"]>) => {
      const command = args[3];
      if (!Array.isArray(command)) throw new Error("expected argv");
      commands.push(command);
      if (args[6]) {
        args[6].on("data", (chunk: Buffer) => staged.push(Buffer.from(chunk)));
        args[6].on("end", () => args[8]?.({ status: "Success" }));
      } else
        queueMicrotask(() => {
          if (
            command.includes("find") ||
            command.some((arg) => arg.includes("find . -regextype"))
          ) {
            args[4]?.write(["a.txt", ".browser-profiles/Cache/blob", "run.sh", ""].join("\0"));
          } else if (command.includes("tar")) {
            expect(args[6]).toBeNull();
            args[4]?.write(archive.subarray(0, 700));
            args[4]?.write(archive.subarray(700));
          }
          args[8]?.({ status: "Success" });
        });
      return { close: vi.fn(), onclose: null, onerror: null } as unknown as Awaited<
        ReturnType<Exec["exec"]>
      >;
    });
    const files = [];
    for await (const file of providerFor({}, exec).exportWorkspace(computer, context))
      files.push(file);
    expect(commands[0]?.join(" ")).toContain("Browser.close");
    expect(commands.filter((command) => command.includes("tar"))).toHaveLength(1);
    expect(Buffer.concat(staged).toString()).toBe("a.txt\0run.sh\0");
    expect(commands.at(-1)?.slice(0, 4)).toEqual([
      "timeout",
      "--signal=TERM",
      "--kill-after=5s",
      "10s",
    ]);
    expect(commands.at(-1)).toContain("rm");
    // Element-wise toEqual on a 2 MiB array takes minutes; compare bytes directly.
    expect(Buffer.from(files[0]!.content).equals(binary)).toBe(true);
    expect(files).toEqual([
      { path: "a.txt", content: expect.any(Uint8Array) },
      { path: "run.sh", content: new Uint8Array(Buffer.from("#!")), executable: true },
    ]);
  });

  it("imports large files through bounded chunks in one tar exec", async () => {
    const stdinChunks: Buffer[] = [];
    const large = Buffer.alloc(64 * 1024 * 1024, 0xa5);
    let largestChunk = 0;
    const exec = vi.fn(async (...args: Parameters<Exec["exec"]>) => {
      const stdin = args[6];
      if (stdin) {
        stdin.on("data", (data: Buffer) => {
          largestChunk = Math.max(largestChunk, data.length);
          stdinChunks.push(data);
        });
        stdin.on("end", () => args[8]?.({ status: "Success" }));
      } else {
        queueMicrotask(() => args[8]?.({ status: "Success" }));
      }
      return { close: vi.fn(), onclose: null, onerror: null } as unknown as Awaited<
        ReturnType<Exec["exec"]>
      >;
    });
    async function* files() {
      yield { path: "one", content: Buffer.from("1") };
      yield { path: `${"d/".repeat(60)}two`, content: Buffer.from("2"), executable: true };
      yield { path: "large.bin", content: large };
    }
    await providerFor({}, exec).importWorkspace(computer, files(), context);
    const tarCalls = exec.mock.calls.filter((call) => (call[3] as string[]).includes("tar"));
    expect(tarCalls).toHaveLength(1);
    expect(largestChunk).toBeLessThanOrEqual(1024 * 1024);
    const reader = new TarReader(large.length);
    const read = reader.push(Buffer.concat(stdinChunks));
    expect(Buffer.from(read[2]!.content).equals(large)).toBe(true);
    expect(read.map((file) => [file.path, file.executable])).toEqual([
      ["one", undefined],
      [`${"d/".repeat(60)}two`, true],
      ["large.bin", undefined],
    ]);
  });

  it("stops importing on cancellation", async () => {
    const controller = new AbortController();
    async function* files() {
      yield { path: "one", content: Buffer.from("1") };
      controller.abort();
      yield { path: "two", content: Buffer.from("2") };
    }
    const consuming = vi.fn(async (...args: Parameters<Exec["exec"]>) => {
      const stdin = args[6];
      if (stdin) stdin.on("data", () => undefined);
      else queueMicrotask(() => args[8]?.({ status: "Success" }));
      return { close: vi.fn(), onclose: null, onerror: null } as unknown as Awaited<
        ReturnType<Exec["exec"]>
      >;
    });
    await expect(
      providerFor({}, consuming).importWorkspace(computer, files(), {
        ...context,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it("formats screen URLs for IPv4 and IPv6 and rejects missing IP", async () => {
    const screenPod = (podIP?: string) => ({ ...readyPod, status: { ...readyPod.status, podIP } });
    for (const [ip, host] of [
      ["10.0.0.8", "10.0.0.8"],
      ["2001:db8::1", "[2001:db8::1]"],
    ] as const) {
      const exec = successfulExec("RAKAZO_DESKTOP=0:token");
      const provider = providerFor(
        { readNamespacedPod: vi.fn().mockResolvedValue(screenPod(ip)) },
        exec,
      );
      await expect(
        provider.connectScreen(computer, { view: "stream", interactive: false }, context),
      ).resolves.toMatchObject({
        url: expect.stringContaining(`http://${host}:`),
      });
      // vnc.html reads localStorage, which the sandboxed frame forbids.
      await expect(
        provider.connectScreen(computer, { view: "stream", interactive: false }, context),
      ).resolves.toMatchObject({ url: expect.stringContaining("/embed.html") });
      const commands = exec.mock.calls.map((call) => (call[3] as string[]).join(" ")).join("\n");
      expect(commands).toContain(`${ip.includes(":") ? "::" : "0.0.0.0"}:6100`);
    }
    await expect(
      providerFor(
        { readNamespacedPod: vi.fn().mockResolvedValue(screenPod(undefined)) },
        successfulExec("RAKAZO_DESKTOP=0:token"),
      ).connectScreen(computer, { view: "stream", interactive: false }, context),
    ).rejects.toThrow("no pod IP");
  });

  it("reports running only for Kubernetes computers in Running phase", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(readyPod)
      .mockResolvedValueOnce({ ...readyPod, status: { phase: "Pending" } });
    const provider = providerFor({ readNamespacedPod: read });
    await expect(provider.isRunning(computer, context)).resolves.toBe(true);
    await expect(provider.isRunning(computer, context)).resolves.toBe(false);
    await expect(provider.isRunning({ ...computer, kind: "docker" }, context)).resolves.toBe(false);
  });

  it.each(["stop", "destroy"] as const)(
    "%s deletes immediately and ignores 404",
    async (method) => {
      const del = vi.fn().mockRejectedValue(Object.assign(new Error("gone"), { code: 404 }));
      const provider = providerFor({ deleteNamespacedPod: del });
      await expect(provider[method](computer, context)).resolves.toBeUndefined();
      expect(del).toHaveBeenCalledWith(
        expect.objectContaining({ gracePeriodSeconds: 0, name: "pod" }),
        expect.anything(),
      );
    },
  );

  it("describes contract and capabilities", () => {
    expect(providerFor().describe()).toMatchObject({
      contractVersion: "1",
      capabilities: {
        graphical: true,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: false,
        multiScreen: true,
      },
    });
  });
  it("waits for a terminating pod before creating its replacement", async () => {
    const dying = {
      ...readyPod,
      metadata: { ...readyPod.metadata, deletionTimestamp: new Date() },
    };
    const read = vi
      .fn()
      .mockResolvedValueOnce(dying)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(readyPod);
    const create = vi.fn().mockResolvedValue(readyPod);
    const provider = providerFor({ readNamespacedPod: read, createNamespacedPod: create });
    await expect(provider.isRunning(computer, context)).resolves.toBe(false);
    read
      .mockReset()
      .mockResolvedValueOnce(dying)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(readyPod);
    await expect(
      provider.provision(
        { botId: "bot-a", homePath: "/unused", providerKind: "kubernetes", providerRef: "pod" },
        context,
      ),
    ).resolves.toMatchObject({ fresh: true });
    expect(create).toHaveBeenCalledOnce();
  });

  it("does not return a pod that starts terminating during readiness", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(readyPod)
      .mockResolvedValue({
        ...readyPod,
        metadata: { ...readyPod.metadata, deletionTimestamp: new Date() },
      });
    await expect(
      providerFor({ readNamespacedPod: read }).provision(
        { botId: "bot-a", homePath: "/unused", providerRef: "pod", providerKind: "kubernetes" },
        context,
      ),
    ).rejects.toMatchObject({ name: "SandboxNotFoundError" });
  });

  it.each(["abort", "timeout"])(
    "finishes %s while exec is connecting and closes a late socket",
    async (mode) => {
      vi.useFakeTimers();
      try {
        let connect!: (socket: Awaited<ReturnType<Exec["exec"]>>) => void;
        const exec = vi.fn(
          () =>
            new Promise<Awaited<ReturnType<Exec["exec"]>>>((resolve) => {
              connect = resolve;
            }),
        );
        const controller = new AbortController();
        const consume = async () => {
          const events: ProcessEvent[] = [];
          for await (const event of providerFor({}, exec).execute(
            computer,
            { argv: ["sleep", "10"], timeoutMs: 1_000 },
            { ...context, signal: controller.signal },
          ))
            events.push(event);
          return events;
        };
        const result = consume();
        await vi.advanceTimersByTimeAsync(0);
        if (mode === "abort") controller.abort();
        else await vi.advanceTimersByTimeAsync(11_000);
        expect(await result).toContainEqual({ type: "exit", code: mode === "abort" ? 130 : 124 });
        const socket = { close: vi.fn() } as unknown as Awaited<ReturnType<Exec["exec"]>>;
        connect(socket);
        await vi.advanceTimersByTimeAsync(0);
        expect(socket.close).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([undefined, { ...readyPod, status: { phase: "Failed" } }])(
    "reports confirmed pod loss during control cleanup",
    async (pod) => {
      const read = vi.fn().mockResolvedValue(pod);
      await expect(
        providerFor(
          { readNamespacedPod: read },
          successfulExec("", "desktop broke", 1),
        ).setScreenControl(computer, false, context, "control-token"),
      ).rejects.toMatchObject({ name: "SandboxNotFoundError" });
    },
  );

  it("does not classify a desktop error on a live pod as pod loss", async () => {
    await expect(
      providerFor({}, successfulExec("", "desktop broke", 1)).setScreenControl(
        computer,
        false,
        context,
        "control-token",
      ),
    ).rejects.toThrow("desktop broke");
  });

  it("does not classify an API outage as pod loss", async () => {
    const provider = providerFor({
      readNamespacedPod: vi.fn().mockRejectedValue(new Error("API offline")),
    });
    await expect(
      provider.setScreenControl(computer, false, context, "control-token"),
    ).rejects.toThrow("API offline");
  });

  it.skipIf(process.platform !== "linux")(
    "exports real GNU tar long paths and hardlinks intact",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "rakazo-tar-"));
      try {
        const long = `nested/${"a".repeat(110)}.txt`;
        await mkdir(path.join(root, "nested"));
        await writeFile(path.join(root, long), "long file");
        await link(path.join(root, long), path.join(root, "linked.txt"));
        const exec = vi.fn(async (...args: Parameters<Exec["exec"]>) => {
          const argv = args[3] as string[];
          const script = argv[argv.indexOf("bash") + 2];
          queueMicrotask(() => {
            if (script?.includes(" workspace-save ")) {
              args[4]?.write(
                execFileSync("bash", [
                  "-c",
                  script.replace(`cd ${shellQuote("/home/rakazo")}`, `cd ${shellQuote(root)}`),
                ]),
              );
            } else if (args[6]) {
              args[6].resume();
            } else if (argv.includes("tar")) {
              const command = argv.slice(argv.indexOf("tar") + 1);
              command[command.indexOf("-C") + 1] = root;
              command.splice(command.indexOf("-T"), 2, long, "linked.txt");
              args[4]?.write(execFileSync("tar", command));
            }
            args[8]?.({ status: "Success" });
          });
          return { close: vi.fn() } as unknown as Awaited<ReturnType<Exec["exec"]>>;
        });
        const exported = [];
        for await (const file of providerFor({}, exec).exportWorkspace(computer, context))
          exported.push(file);
        expect(exported.map((file) => file.path)).toEqual([long, "linked.txt"]);
        expect(exported.map((file) => Buffer.from(file.content).toString())).toEqual([
          "long file",
          "long file",
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it.each(["caller", "deadline"])("bounds stalled desktop environment reads (%s)", async (mode) => {
    vi.useFakeTimers();
    const timeout = fakeRequestDeadline();
    try {
      const controller = new AbortController();
      const read = vi.fn<KubernetesSandboxSdk["core"]["readNamespacedPod"]>(
        () => new Promise<V1Pod>(() => {}),
      );
      const provider = providerFor({ readNamespacedPod: read });
      const result = provider.releaseScreen(computer, { ...context, signal: controller.signal });
      const assertion = expect(result).rejects.toThrow();
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
      if (mode === "caller") controller.abort(new Error("caller cancelled"));
      else await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      const options = read.mock.calls[0]?.[1];
      const setSignal = vi.fn();
      await options?.middleware?.[0]?.pre({ setSignal } as never).toPromise();
      expect(setSignal).toHaveBeenCalledWith(expect.objectContaining({ aborted: true }));
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("bounds stalled pod deletion without letting cancellation skip it", async () => {
    vi.useFakeTimers();
    const timeout = fakeRequestDeadline();
    try {
      const cancelled = AbortSignal.abort(new Error("run cancelled"));
      const terminalPod = { ...readyPod, status: { phase: "Failed" } };
      const operations = [
        (provider: KubernetesSandboxProvider) =>
          provider.stop(computer, { ...context, signal: cancelled }),
        (provider: KubernetesSandboxProvider) =>
          provider.destroy(computer, { ...context, signal: cancelled }),
        (provider: KubernetesSandboxProvider) =>
          provider.provision({ botId: "bot-a", homePath: "/unused", providerRef: "pod" }, context),
      ];
      for (const operation of operations) {
        const del = vi.fn<KubernetesSandboxSdk["core"]["deleteNamespacedPod"]>(
          () => new Promise<V1Pod>(() => {}),
        );
        const provider = providerFor({
          readNamespacedPod: vi.fn().mockResolvedValue(terminalPod),
          deleteNamespacedPod: del,
        });
        let outcome: unknown = "pending";
        operation(provider).catch((error) => {
          outcome = error;
        });
        await vi.waitFor(() => expect(del).toHaveBeenCalledOnce());
        expect(outcome).toBe("pending");
        await vi.advanceTimersByTimeAsync(10_000);
        expect(outcome).toEqual(new Error("request deadline"));
        const setSignal = vi.fn();
        await del.mock.calls[0]?.[1]?.middleware?.[0]?.pre({ setSignal } as never).toPromise();
        expect(setSignal).toHaveBeenCalledWith(expect.objectContaining({ aborted: true }));
      }
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("returns the original start error after cleanup outlasts a cancelled caller", async () => {
    vi.useFakeTimers();
    const timeout = fakeRequestDeadline();
    try {
      const controller = new AbortController();
      const read = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: 404 }))
        .mockReturnValue(new Promise<V1Pod>(() => {}));
      const del = vi.fn(() => new Promise<V1Pod>(() => {}));
      const provider = providerFor({ readNamespacedPod: read, deleteNamespacedPod: del });
      let outcome: unknown = "pending";
      provider
        .provision(
          { botId: "bot-a", homePath: "/unused" },
          { ...context, signal: controller.signal },
        )
        .catch((error) => {
          outcome = error;
        });
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      controller.abort(new Error("caller cancelled"));
      await vi.waitFor(() => expect(del).toHaveBeenCalledOnce());
      expect(outcome).toBe("pending");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(outcome).toEqual(new Error("caller cancelled"));
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
});
