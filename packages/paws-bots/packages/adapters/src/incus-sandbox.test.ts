import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PeerCertificate } from "node:tls";
import { rootCertificates } from "node:tls";
import type { AdapterContext, ComputerRef, ProcessEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { encodeTarEntry } from "./exec-computer.js";
import type {
  IncusClient,
  IncusResponse,
  IncusSocket,
  IncusSocketHandlers,
} from "./incus-sandbox.js";
import {
  IncusError,
  IncusSandboxProvider,
  incusTlsOptions,
  ociImageSource,
} from "./incus-sandbox.js";
import { assertSandboxWorkspaceContract, provisionPrepared } from "./sandbox-test-support.js";

const context: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

const computer: ComputerRef = {
  id: "box",
  botId: "bot-a",
  kind: "incus",
  providerRef: "box",
};

type Output = { stdout?: string | Buffer; stderr?: string | Buffer; code?: number };
/** Runs one exec in the fake: `hang` waits until the client signals or closes the command. */
type Runner = (command: string[], input: Buffer, tty: boolean) => Output | "hang";

interface Instance {
  status: string;
  ephemeral: boolean;
  config: Record<string, string>;
  state?: {
    network: Record<string, { addresses: { family: string; address: string; scope: string }[] }>;
  };
}

interface Exec {
  command: string[];
  body: Record<string, unknown>;
  signals: number[];
  input: Buffer[];
  inputClosed: boolean;
  closed: Set<string>;
  handlers: Map<string, IncusSocketHandlers>;
  finish: (code: number) => void;
}

function running(botId = "bot-a", address = "10.0.0.8"): Instance {
  return {
    status: "Running",
    ephemeral: true,
    config: { "user.rakazo-bot-id": botId },
    state: {
      network: {
        lo: { addresses: [{ family: "inet", address: "127.0.0.1", scope: "local" }] },
        eth0: {
          addresses: [
            { family: address.includes(":") ? "inet6" : "inet", address, scope: "global" },
            { family: "inet6", address: "fe80::1", scope: "link" },
          ],
        },
      },
    },
  };
}

/** An in-memory Incus API with the behaviour the provider relies on, as observed on Incus 7. */
class FakeIncus implements IncusClient {
  readonly instances = new Map<string, Instance>();
  readonly requests: { method: string; path: string; body: unknown }[] = [];
  readonly execs: Exec[] = [];
  /** Lets a test change an instance between the provider's reads. */
  onRead?: (name: string) => void;
  failCreate?: (name: string) => void;
  /** Creates the instance, then fails the operation, as a start that fails does. */
  failStart?: boolean;
  /** Holds instance creation until it settles, as an image download does. */
  createGate?: Promise<void>;
  /** Holds an exec's control stream; Incus starts the command without it. */
  controlGate?: Promise<void>;
  private readonly operations = new Map<string, Promise<Record<string, unknown>>>();
  /** Operations still creating an instance, by id, as Incus lists them. */
  private readonly creating = new Map<string, string>();
  private readonly secrets = new Map<string, { exec: Exec; fd: string }>();
  private next = 0;

  constructor(private readonly runner: Runner = () => ({})) {}

  async request(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<IncusResponse> {
    signal.throwIfAborted();
    this.requests.push({ method, path, body });
    const url = new URL(path, "https://incus.test");
    const parts = url.pathname.split("/").slice(2).map(decodeURIComponent);
    if (parts[0] === "operations" && parts[2] === "wait") {
      return { metadata: await abortable(this.operations.get(parts[1]!)!, signal) };
    }
    if (parts[0] === "operations" && !parts[1]) {
      const running = [...this.creating].map(([id, name]) => ({
        id,
        status_code: 103,
        resources: { instances: [`/1.0/instances/${name}?project=default`] },
      }));
      return { metadata: { running } };
    }
    if (parts[0] !== "instances") throw new IncusError("not found", 404);
    const name = parts[1];
    if (method === "GET" && !name) {
      const [, botId] =
        /^config\.user\.rakazo-bot-id eq (\S+)$/.exec(url.searchParams.get("filter") ?? "") ?? [];
      return {
        metadata: [...this.instances]
          .filter(([, instance]) => instance.config["user.rakazo-bot-id"] === botId)
          .map(([instanceName, instance]) => ({
            name: instanceName,
            ...structuredClone(instance),
          })),
      };
    }
    if (method === "POST" && !name) return this.create(body as Record<string, unknown>);
    if (!name) throw new IncusError("not found", 404);
    this.onRead?.(name);
    const instance = this.instances.get(name);
    if (!instance)
      throw new IncusError(`Failed to fetch instance "${name}": Instance not found`, 404);
    if (method === "GET" && !parts[2]) return { metadata: { name, ...structuredClone(instance) } };
    if (method === "PUT" && parts[2] === "state") {
      if (instance.status !== "Running")
        throw new IncusError("The instance is already stopped", 400);
      if (instance.ephemeral) this.instances.delete(name);
      else instance.status = "Stopped";
      return this.operation(Promise.resolve({ status: "Success", status_code: 200 }));
    }
    if (method === "DELETE" && !parts[2]) {
      if (instance.status === "Running") throw new IncusError("Instance is running", 400);
      this.instances.delete(name);
      return this.operation(Promise.resolve({ status: "Success", status_code: 200 }));
    }
    if (method === "POST" && parts[2] === "exec") {
      if (instance.status !== "Running") throw new IncusError("Instance is not running", 400);
      return this.exec(body as Record<string, unknown>);
    }
    throw new IncusError("not implemented", 501);
  }

  async websocket(path: string, handlers: IncusSocketHandlers): Promise<IncusSocket> {
    const url = new URL(path, "https://incus.test");
    this.requests.push({ method: "WEBSOCKET", path, body: undefined });
    const entry = this.secrets.get(url.searchParams.get("secret") ?? "");
    if (!entry) throw new Error("unknown websocket secret");
    const { exec, fd } = entry;
    if (fd === "control") await this.controlGate;
    exec.handlers.set(fd, handlers);
    queueMicrotask(() => this.maybeStart(exec));
    return {
      send: async (data) => {
        if (fd === "control") exec.signals.push(JSON.parse(String(data)).signal);
        else exec.input.push(Buffer.from(data));
        if (fd === "control") exec.finish(128 + exec.signals.at(-1)!);
      },
      close: () => {
        if (exec.closed.has(fd)) return;
        exec.closed.add(fd);
        if (fd === "0") {
          exec.inputClosed = true;
          this.maybeStart(exec);
        }
      },
    };
  }

  private create(body: Record<string, unknown>): IncusResponse {
    const name = String(body.name);
    if (this.instances.has(name)) throw new IncusError(`Instance "${name}" already exists`, 500);
    this.failCreate?.(name);
    const config = body.config as Record<string, string>;
    const created = (this.createGate ?? Promise.resolve()).then(() => {
      this.instances.set(name, {
        ...running(config["user.rakazo-bot-id"]),
        ...(this.failStart ? { status: "Stopped" } : {}),
        config: { ...config },
      });
      return this.failStart
        ? { status: "Failure", status_code: 400, err: "Failed to start instance" }
        : { status: "Success", status_code: 200 };
    });
    const response = this.operation(created);
    const id = response.operation!.split("/").pop()!;
    this.creating.set(id, name);
    void created.finally(() => this.creating.delete(id));
    return response;
  }

  private exec(body: Record<string, unknown>): IncusResponse {
    const tty = body.interactive === true;
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => (finish = resolve));
    const exec: Exec = {
      command: body.command as string[],
      body,
      signals: [],
      input: [],
      inputClosed: false,
      closed: new Set(),
      handlers: new Map(),
      finish: (code) => finish(code),
    };
    this.execs.push(exec);
    const fds = Object.fromEntries(
      (tty ? ["0", "control"] : ["0", "1", "2", "control"]).map((fd) => {
        const secret = `secret-${this.next++}`;
        this.secrets.set(secret, { exec, fd });
        return [fd, secret];
      }),
    );
    const finished = done.then(async (code) => {
      // An interactive command ends only once the client closes its stream.
      if (tty) await vi.waitFor(() => expect(exec.closed.has("0")).toBe(true));
      return { status: "Success", status_code: 200, metadata: { return: code } };
    });
    return { ...this.operation(finished), metadata: { metadata: { fds } } };
  }

  private started = new WeakSet<Exec>();

  private maybeStart(exec: Exec) {
    const tty = exec.body.interactive === true;
    const required = tty ? ["0"] : ["0", "1", "2"];
    if (!required.every((fd) => exec.handlers.has(fd))) return;
    if (!tty && !exec.inputClosed) return;
    if (this.started.has(exec)) return;
    this.started.add(exec);
    const result = this.runner(exec.command, Buffer.concat(exec.input), tty);
    if (result === "hang") return;
    const emit = (fd: string, data: string | Buffer | undefined) => {
      if (data?.length) exec.handlers.get(fd)?.message(Buffer.from(data), true);
    };
    if (tty) {
      emit("0", result.stdout);
      exec.handlers.get("0")?.message(Buffer.alloc(0), false);
    } else {
      emit("1", result.stdout);
      emit("2", result.stderr);
      exec.handlers.get("1")?.close();
      exec.handlers.get("2")?.close();
    }
    exec.finish(result.code ?? 0);
  }

  private operation(result: Promise<Record<string, unknown>>): IncusResponse {
    const id = `op-${this.next++}`;
    this.operations.set(id, result);
    return { metadata: {}, operation: `/1.0/operations/${id}` };
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    promise.then(resolve, reject);
  });
}

function providerFor(
  fake = new FakeIncus(),
  options: Partial<ConstructorParameters<typeof IncusSandboxProvider>[0]> = {},
) {
  return new IncusSandboxProvider(
    { url: "https://incus.test:8443", clientCert: "cert", clientKey: "key", ...options },
    fake,
  );
}

async function collect(events: AsyncIterable<ProcessEvent>) {
  const collected: ProcessEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("IncusSandboxProvider", () => {
  it("passes the shared offline sandbox workspace contract", async () => {
    const files = new Map<string, { content: Buffer; executable: boolean }>();
    let exportedNames: string[] = [];
    const fake = new FakeIncus((command, input) => {
      const write = command.indexOf("rakazo-write");
      if (write >= 0) {
        files.set(command[write + 1]!, {
          content: input,
          executable: command[write + 2] === "700",
        });
        return {};
      }
      if (command.includes("rakazo-export-list")) {
        exportedNames = input.toString().split("\0").filter(Boolean);
        return {};
      }
      if (command.includes("echo")) return { stdout: "graphical-ok\n" };
      if (command.includes("stat"))
        return { stdout: String(files.get(command.at(-1)!)!.content.length) };
      if (command.includes("cat")) return { stdout: files.get(command.at(-1)!)!.content };
      if (command.includes("find") || command.some((arg) => arg.includes("find . -regextype"))) {
        const directory = command.includes("find")
          ? command[command.indexOf("find") + 1]!
          : "/home/rakazo";
        let stdout = "";
        for (const [name, file] of files) {
          if (!name.startsWith(`${directory}/`)) continue;
          const relative = name.slice(directory.length + 1);
          if (!command.includes("-maxdepth")) stdout += `${relative}\0`;
          else if (!relative.includes("/"))
            stdout += `${relative}\0f\0${file.content.length}\0${file.executable ? "700" : "600"}\0`;
        }
        return { stdout };
      }
      if (command.includes("tar")) {
        const chunks = exportedNames.flatMap((name) => {
          const file = files.get(`/home/rakazo/${name}`)!;
          return [...encodeTarEntry(name, file.content, file.executable)];
        });
        return { stdout: Buffer.concat([...chunks, Buffer.alloc(1024)]) };
      }
      if (command.some((arg) => arg.includes("RAKAZO_DESKTOP=")))
        return { stdout: "RAKAZO_DESKTOP=0:offline-view-token\n" };
      if (command.some((arg) => arg.includes("getmouselocation")))
        return { stdout: "cG5n\nCURSOR X=1 Y=2\n" };
      return {};
    });
    const provider = providerFor(fake);
    const provisioned = await provisionPrepared(
      provider,
      { botId: "bot-a", homePath: "/unused" },
      context,
    );
    await assertSandboxWorkspaceContract(provider, provisioned, context);
    await provider.destroy(provisioned, context);
    expect(fake.instances.size).toBe(0);
  });

  it("creates an unprivileged, capped, ephemeral instance from the computer image", async () => {
    const fake = new FakeIncus();
    const provider = providerFor(fake, {
      project: "computers",
      computerImage: "registry.example.test/rakazo/computer:v1",
      cpuLimit: "1",
      memoryLimit: "1536MiB",
      processLimit: "512",
    });

    const created = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);

    expect(created).toMatchObject({ kind: "incus", botId: "bot-a", fresh: true });
    expect(created.providerRef).toMatch(/^rakazo-[0-9a-f-]{36}$/);
    const create = fake.requests.find(
      (entry) => entry.method === "POST" && entry.path.startsWith("/1.0/instances?"),
    );
    expect(create?.path).toBe("/1.0/instances?project=computers");
    expect(create?.body).toMatchObject({
      name: created.providerRef,
      type: "container",
      ephemeral: true,
      start: true,
      source: {
        type: "image",
        protocol: "oci",
        server: "https://registry.example.test",
        alias: "rakazo/computer:v1",
      },
      config: {
        "user.rakazo-bot-id": "bot-a",
        "limits.cpu": "1",
        "limits.memory": "1536MiB",
        "limits.processes": "512",
        "security.privileged": "false",
        "security.nesting": "false",
        "security.idmap.isolated": "true",
        "environment.VNC_RESOLUTION": "1280x800",
      },
    });
    // The image's own command starts without privilege escalation, so nothing it launches,
    // such as the window manager's menu, can regain it.
    const dockerfile = readFileSync(
      path.join(import.meta.dirname, "../../../infra/sandboxes/computer/Dockerfile"),
      "utf8",
    );
    const imageCommand = JSON.parse(dockerfile.match(/^CMD (\[.*\])$/m)![1]!) as string[];
    expect((create!.body as { config: Record<string, string> }).config["oci.entrypoint"]).toBe(
      `setpriv --no-new-privs -- ${imageCommand.join(" ")}`,
    );
    // The start command's uid and gid are set on the instance, not inherited from
    // the image's `USER`: a custom image without one starts as unprivileged anyway.
    expect((create!.body as { config: Record<string, string> }).config["oci.uid"]).toBe("1000");
    expect((create!.body as { config: Record<string, string> }).config["oci.gid"]).toBe("1000");
    // Only image paths and settings reach the instance environment.
    const environment = Object.entries((create!.body as { config: Record<string, string> }).config)
      .filter(([key]) => key.startsWith("environment."))
      .map(([key]) => key);
    expect(environment.sort()).toEqual(
      [
        "environment.PIP_CACHE_DIR",
        "environment.PLAYWRIGHT_BROWSERS_PATH",
        "environment.UV_CACHE_DIR",
        "environment.VNC_RESOLUTION",
        "environment.XDG_CACHE_HOME",
        "environment.npm_config_cache",
      ].sort(),
    );
    // Every request and stream is scoped to the configured project.
    expect(fake.requests.every((entry) => entry.path.includes("project=computers"))).toBe(true);
    await expect(provider.isRunning(created, context)).resolves.toBe(true);
  });

  it("defaults to the Docker computer's ceilings", async () => {
    const fake = new FakeIncus();
    await providerFor(fake).provision({ botId: "bot-a", homePath: "/unused" }, context);
    expect(fake.requests.find((entry) => entry.method === "POST")?.body).toMatchObject({
      source: { server: "https://ghcr.io", alias: "elie222/rakazo/computer:edge" },
      config: { "limits.cpu": "2", "limits.memory": "2GiB", "limits.processes": "2048" },
    });
  });

  it("waits for the image's desktop gateway before returning", async () => {
    let probes = 0;
    const fake = new FakeIncus((command) => {
      if (command.some((arg) => arg.includes("/dev/tcp/127.0.0.1/6080"))) {
        probes += 1;
        return { code: probes < 2 ? 1 : 0 };
      }
      return {};
    });
    await providerFor(fake).provision({ botId: "bot-a", homePath: "/unused" }, context);
    expect(probes).toBe(2);
    expect(fake.execs[0]?.body).toMatchObject({ user: 1000, group: 1000, cwd: "/home/rakazo" });
  });

  it("reconnects to a running instance of the same bot without creating one", async () => {
    const fake = new FakeIncus();
    fake.instances.set("box", running());
    const result = await providerFor(fake).provision(
      { botId: "bot-a", homePath: "/unused", providerKind: "incus", providerRef: "box" },
      context,
    );
    expect(result).toMatchObject({ providerRef: "box", fresh: false });
    expect(
      fake.requests.some((entry) => entry.method === "POST" && !entry.path.includes("exec")),
    ).toBe(false);
  });

  it("never reuses or replaces another bot's instance", async () => {
    const fake = new FakeIncus();
    fake.instances.set("box", running("bot-b"));
    await expect(
      providerFor(fake).provision(
        { botId: "bot-a", homePath: "/unused", providerKind: "incus", providerRef: "box" },
        context,
      ),
    ).rejects.toThrow("belongs to another bot");
    expect(fake.instances.get("box")?.status).toBe("Running");
  });

  it("ignores a stored reference from another provider", async () => {
    const fake = new FakeIncus();
    fake.instances.set("box", running());
    const result = await providerFor(fake).provision(
      { botId: "bot-a", homePath: "/unused", providerKind: "docker", providerRef: "box" },
      context,
    );
    expect(result).toMatchObject({ fresh: true });
    expect(result.providerRef).not.toBe("box");
  });

  it("starts each new instance under a name of its own", async () => {
    const fake = new FakeIncus();
    const provider = providerFor(fake);
    const first = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    await provider.stop(first, context);
    const second = await provider.provision(
      {
        botId: "bot-a",
        homePath: "/unused",
        providerKind: "incus",
        providerRef: first.providerRef,
      },
      context,
    );
    expect(second).toMatchObject({ fresh: true });
    expect(second.providerRef).not.toBe(first.providerRef);
  });

  it("reports a failed create when nothing was created", async () => {
    const fake = new FakeIncus();
    fake.failCreate = () => {
      throw new IncusError("Failed getting remote image info: not found", 500);
    };
    await expect(
      providerFor(fake).provision({ botId: "bot-a", homePath: "/unused" }, context),
    ).rejects.toThrow("remote image info");
    // An answered refusal created nothing, so nothing is looked for.
    expect(fake.requests.some((entry) => entry.path.startsWith("/1.0/operations?"))).toBe(false);
  });

  it("deletes an instance whose create request lost its answer", async () => {
    const fake = new FakeIncus();
    let release!: () => void;
    fake.createGate = new Promise((resolve) => (release = resolve));
    const request = fake.request.bind(fake);
    vi.spyOn(fake, "request").mockImplementation(async (method, path, body, signal) => {
      const response = await request(method, path, body, signal);
      // Incus accepted the creation, but the answer never arrived.
      if (method === "POST" && path.startsWith("/1.0/instances?"))
        throw new Error("socket hang up");
      return response;
    });
    await expect(
      providerFor(fake).provision({ botId: "bot-a", homePath: "/unused" }, context),
    ).rejects.toThrow("socket hang up");
    release();
    await vi.waitFor(() =>
      expect(fake.requests.some((entry) => entry.method === "PUT")).toBe(true),
    );
    expect(fake.instances.size).toBe(0);
  });

  it("deletes an instance whose start failed", async () => {
    const fake = new FakeIncus();
    fake.failStart = true;
    await expect(
      providerFor(fake).provision({ botId: "bot-a", homePath: "/unused" }, context),
    ).rejects.toThrow("Failed to start instance");
    await vi.waitFor(() => expect(fake.instances.size).toBe(0));
  });

  it("deletes an instance whose start was cancelled once Incus has created it", async () => {
    const fake = new FakeIncus();
    let release!: () => void;
    fake.createGate = new Promise((resolve) => (release = resolve));
    const controller = new AbortController();
    const provisioning = providerFor(fake).provision(
      { botId: "bot-a", homePath: "/unused" },
      { ...context, signal: controller.signal },
    );
    await vi.waitFor(() =>
      expect(fake.requests.some((entry) => entry.path.startsWith("/1.0/instances?"))).toBe(true),
    );
    controller.abort();
    await expect(provisioning).rejects.toThrow();
    // Incus goes on to create and start the instance; nothing else knows its name.
    release();
    await vi.waitFor(() =>
      expect(fake.requests.some((entry) => entry.method === "PUT")).toBe(true),
    );
    expect(fake.instances.size).toBe(0);
  });

  it.each([
    ["stopped", { ...running(), status: "Stopped" }],
    ["failed", { ...running(), status: "Error" }],
  ])("replaces a %s instance of the same bot with a new one", async (_kind, instance) => {
    const fake = new FakeIncus();
    fake.instances.set("box", { ...instance, ephemeral: false });
    const result = await providerFor(fake).provision(
      { botId: "bot-a", homePath: "/unused", providerKind: "incus", providerRef: "box" },
      context,
    );
    expect(result).toMatchObject({ fresh: true });
    expect(result.providerRef).not.toBe("box");
    expect(fake.instances.has("box")).toBe(false);
  });

  it("removes a new instance that does not become ready", async () => {
    const fake = new FakeIncus((command) =>
      command.some((arg) => arg.includes("/dev/tcp")) ? { code: 1 } : {},
    );
    await expect(
      providerFor(fake, { readyTimeoutMs: 1 }).provision(
        { botId: "bot-a", homePath: "/unused" },
        context,
      ),
    ).rejects.toThrow("did not become ready");
    expect(fake.instances.size).toBe(0);
  });

  it("rejects an instance that disappears while starting", async () => {
    const fake = new FakeIncus((command) => {
      // The readiness probe finds the instance gone.
      if (command.some((arg) => arg.includes("/dev/tcp"))) fake.instances.clear();
      return { code: 1 };
    });
    await expect(
      providerFor(fake).provision({ botId: "bot-a", homePath: "/unused" }, context),
    ).rejects.toThrow("disappeared while starting");
  });

  it.each(["stop", "destroy"] as const)(
    "%s stops the ephemeral instance, which deletes it",
    async (method) => {
      const fake = new FakeIncus();
      fake.instances.set("box", running());
      const provider = providerFor(fake);
      await provider[method](computer, context);
      expect(fake.instances.has("box")).toBe(false);
      expect(fake.requests.find((entry) => entry.method === "PUT")?.body).toEqual({
        action: "stop",
        force: true,
      });
      await expect(provider[method](computer, context)).resolves.toBeUndefined();
      await expect(provider.isRunning(computer, context)).resolves.toBe(false);
    },
  );

  it.each(["stop", "destroy"] as const)(
    "%s never removes another bot's instance",
    async (method) => {
      const fake = new FakeIncus();
      fake.instances.set("box", running("bot-b"));
      await expect(providerFor(fake)[method](computer, context)).rejects.toThrow(
        "belongs to another bot",
      );
      expect(fake.instances.get("box")?.status).toBe("Running");
    },
  );

  it("removes this bot's instances that no saved reference points to before starting", async () => {
    const fake = new FakeIncus();
    fake.instances.set("orphan", running());
    fake.instances.set("stopped-ref", { ...running(), status: "Stopped", ephemeral: false });
    fake.instances.set("other-bot", running("bot-b"));
    const result = await providerFor(fake).provision(
      { botId: "bot-a", homePath: "/unused", providerKind: "incus", providerRef: "stopped-ref" },
      context,
    );
    expect([...fake.instances.keys()].sort()).toEqual([result.providerRef, "other-bot"].sort());
  });

  it("still starts when removing an earlier instance fails", async () => {
    const fake = new FakeIncus();
    fake.instances.set("orphan", running());
    const request = fake.request.bind(fake);
    vi.spyOn(fake, "request").mockImplementation(async (method, path, body, signal) => {
      if (method === "PUT" && path.startsWith("/1.0/instances/orphan/"))
        throw new IncusError("Instance is busy", 500);
      return request(method, path, body, signal);
    });
    await expect(
      providerFor(fake).provision({ botId: "bot-a", homePath: "/unused" }, context),
    ).resolves.toMatchObject({ fresh: true });
  });

  it("still starts when listing earlier instances fails", async () => {
    const fake = new FakeIncus();
    const request = fake.request.bind(fake);
    vi.spyOn(fake, "request").mockImplementation(async (method, path, body, signal) => {
      if (method === "GET" && path.startsWith("/1.0/instances?recursion=1&filter="))
        throw new Error("connect ECONNRESET");
      return request(method, path, body, signal);
    });
    await expect(
      providerFor(fake).provision({ botId: "bot-a", homePath: "/unused" }, context),
    ).resolves.toMatchObject({ fresh: true });
  });

  it("deletes an instance that stays after stopping", async () => {
    const fake = new FakeIncus();
    fake.instances.set("box", { ...running(), ephemeral: false });
    await providerFor(fake).destroy(computer, context);
    expect(fake.instances.has("box")).toBe(false);
  });

  it("streams stdout and stderr separately and keeps the exit code", async () => {
    const fake = new FakeIncus(() => ({ stdout: "out", stderr: "err", code: 7 }));
    fake.instances.set("box", running());
    const events = await collect(
      providerFor(fake).execute(
        computer,
        { argv: ["printf", "done"], env: { TEST_VALUE: "value" }, cwd: "nested" },
        context,
      ),
    );
    expect(events).toEqual([
      { type: "stdout", data: "out" },
      { type: "stderr", data: "err" },
      { type: "exit", code: 7 },
    ]);
    const exec = fake.execs[0]!;
    expect(exec.body).toMatchObject({ interactive: false, user: 1000, group: 1000 });
    // Setuid programs in the image cannot raise a bot command's privileges.
    expect(exec.command.slice(0, 3)).toEqual(["setpriv", "--no-new-privs", "--"]);
    expect(exec.command).toEqual(
      expect.arrayContaining(["/home/rakazo/nested", "TEST_VALUE=value", "printf", "done"]),
    );
    // The input stream is closed so commands that read stdin see its end.
    expect(exec.inputClosed).toBe(true);
  });

  it("keeps split UTF-8 characters intact", async () => {
    const fake = new FakeIncus(() => ({ stdout: Buffer.from("€"), code: 0 }));
    fake.instances.set("box", running());
    const events = await collect(providerFor(fake).execute(computer, { argv: ["true"] }, context));
    expect(events).toEqual([
      { type: "stdout", data: "€" },
      { type: "exit", code: 0 },
    ]);
  });

  it("runs a terminal command over the single interactive stream", async () => {
    const fake = new FakeIncus((_command, _input, tty) => ({
      stdout: tty ? "/dev/pts/1\r\n" : "",
      code: 3,
    }));
    fake.instances.set("box", running());
    const events = await collect(
      providerFor(fake).execute(computer, { argv: ["tty"], pty: true }, context),
    );
    expect(events).toEqual([
      { type: "stdout", data: "/dev/pts/1\r\n" },
      { type: "exit", code: 3 },
    ]);
    expect(fake.execs[0]?.body).toMatchObject({ interactive: true });
    expect(fake.execs[0]?.closed.has("0")).toBe(true);
  });

  it("sends input and then ends it", async () => {
    const fake = new FakeIncus((_command, input) => ({ stdout: `${input.byteLength}` }));
    fake.instances.set("box", running());
    await providerFor(fake).writeFile(
      computer,
      { path: "data.bin", content: Buffer.alloc(300_000, 1) },
      context,
    );
    expect(Buffer.concat(fake.execs[0]!.input).byteLength).toBe(300_000);
    expect(fake.execs[0]?.inputClosed).toBe(true);
  });

  it("signals a cancelled command so the timeout wrapper stops its whole process group", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fake = new FakeIncus(() => "hang");
      fake.instances.set("box", running());
      const controller = new AbortController();
      const result = collect(
        providerFor(fake).execute(
          computer,
          { argv: ["sleep", "30"] },
          { ...context, signal: controller.signal },
        ),
      );
      await vi.waitFor(() => expect(fake.execs[0]?.handlers.size).toBe(4));
      controller.abort();
      expect(await result).toEqual([
        { type: "stderr", data: "command aborted\n" },
        { type: "exit", code: 130 },
      ]);
      expect(fake.execs[0]?.signals).toEqual([15]);
      // The streams outlast the wrapper's kill-after delay, so a command that ignores SIGTERM
      // is killed with its process group rather than orphaned when they close.
      await vi.advanceTimersByTimeAsync(6_000);
      expect(fake.execs[0]?.closed.has("1")).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fake.execs[0]?.closed).toEqual(new Set(["0", "1", "2", "control"]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("signals a command cancelled before its control stream connected", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let release!: () => void;
      const fake = new FakeIncus(() => "hang");
      fake.controlGate = new Promise((resolve) => (release = resolve));
      fake.instances.set("box", running());
      const controller = new AbortController();
      const result = collect(
        providerFor(fake).execute(
          computer,
          { argv: ["sleep", "30"] },
          { ...context, signal: controller.signal },
        ),
      );
      // The command has started on its data streams.
      await vi.waitFor(() => expect(fake.execs[0]?.handlers.size).toBe(3));
      controller.abort();
      expect((await result).at(-1)).toEqual({ type: "exit", code: 130 });
      expect(fake.execs[0]?.closed.size).toBe(0);
      release();
      await vi.waitFor(() => expect(fake.execs[0]?.signals).toEqual([15]));
      await vi.advanceTimersByTimeAsync(7_000);
      expect(fake.execs[0]?.closed).toEqual(new Set(["0", "1", "2", "control"]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes a command that outlives its deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fake = new FakeIncus(() => "hang");
      fake.instances.set("box", running());
      const result = collect(
        providerFor(fake).execute(computer, { argv: ["sleep", "30"], timeoutMs: 1_000 }, context),
      );
      await vi.waitFor(() => expect(fake.execs[0]?.handlers.size).toBe(4));
      expect(fake.execs[0]?.command).toEqual(expect.arrayContaining(["timeout", "1s"]));
      await vi.advanceTimersByTimeAsync(11_000);
      expect((await result).at(-1)).toEqual({ type: "exit", code: 124 });
      expect(fake.execs[0]?.signals).toEqual([15]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels immediately when the caller already gave up", async () => {
    const fake = new FakeIncus();
    const controller = new AbortController();
    controller.abort();
    expect(
      await collect(
        providerFor(fake).execute(
          computer,
          { argv: ["true"] },
          { ...context, signal: controller.signal },
        ),
      ),
    ).toEqual([
      { type: "stderr", data: "command aborted\n" },
      { type: "exit", code: 130 },
    ]);
    expect(fake.requests).toHaveLength(0);
  });

  it("finishes cancellation while the exec request is still pending", async () => {
    const fake = new FakeIncus();
    let pending!: (signal: AbortSignal) => void;
    const request = vi.spyOn(fake, "request").mockImplementation(
      (_method, _path, _body, signal) =>
        new Promise((_resolve, reject) => {
          pending = () => reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const controller = new AbortController();
    const result = collect(
      providerFor(fake).execute(
        computer,
        { argv: ["true"] },
        { ...context, signal: controller.signal },
      ),
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    controller.abort();
    expect((await result).at(-1)).toEqual({ type: "exit", code: 130 });
    expect(pending).toBeTypeOf("function");
  });

  it("reports a command on a missing instance as a gone computer", async () => {
    const iterator = providerFor()
      .execute(computer, { argv: ["true"] }, context)
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ name: "SandboxNotFoundError" });
  });

  it("does not report an API outage as a gone computer", async () => {
    const fake = new FakeIncus();
    vi.spyOn(fake, "request").mockRejectedValue(new Error("connect ECONNREFUSED"));
    const iterator = providerFor(fake)
      .execute(computer, { argv: ["true"] }, context)
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("ECONNREFUSED");
  });

  it("rejects when a stream fails", async () => {
    const fake = new FakeIncus(() => "hang");
    fake.instances.set("box", running());
    const iterator = providerFor(fake)
      .execute(computer, { argv: ["true"] }, context)
      [Symbol.asyncIterator]();
    const next = iterator.next();
    await vi.waitFor(() => expect(fake.execs[0]?.handlers.size).toBe(4));
    fake.execs[0]!.handlers.get("1")!.error(new Error("socket broke"));
    await expect(next).rejects.toThrow("socket broke");
  });

  it("validates environment names", async () => {
    const fake = new FakeIncus();
    fake.instances.set("box", running());
    const iterator = providerFor(fake)
      .execute(computer, { argv: ["true"], env: { "BAD-NAME": "x" } }, context)
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("invalid environment name");
  });

  it.each([
    ["10.0.0.8", "http://10.0.0.8:6100/embed.html", "0.0.0.0:6100"],
    ["fd42::8", "http://[fd42::8]:6100/embed.html", ":::6100"],
  ])("serves screens from the instance address %s", async (address, url, bind) => {
    const fake = new FakeIncus((command) =>
      command.some((arg) => arg.includes("RAKAZO_DESKTOP="))
        ? { stdout: "RAKAZO_DESKTOP=0:token\n" }
        : {},
    );
    fake.instances.set("box", running("bot-a", address));
    const session = await providerFor(fake).connectScreen(
      computer,
      { view: "stream", interactive: false },
      context,
    );
    expect(session.url).toContain(url);
    expect(fake.execs.map((exec) => exec.command.join(" ")).join("\n")).toContain(bind);
  });

  it("refuses a screen for an instance without an address", async () => {
    const fake = new FakeIncus();
    fake.instances.set("box", { ...running(), state: { network: {} } });
    await expect(
      providerFor(fake).connectScreen(computer, { view: "stream", interactive: false }, context),
    ).rejects.toThrow("no network address");
  });

  it("attaches the controlled terminal without replacing the bot run screen fence", async () => {
    const fake = new FakeIncus(() => ({ stdout: "RAKAZO_DESKTOP=0:view-token\n" }));
    fake.instances.set("box", running());
    await providerFor(fake).connectTerminal(
      computer,
      { controlToken: "control-token", cwd: "" },
      { ...context, botId: "bot-a", screenLeaseId: "run-id:7" },
    );
    const commands = fake.execs.map((exec) => exec.command.join(" ")).join("\n");
    expect(commands).toContain("control-token");
    expect(commands).not.toContain("run-id:7");
  });

  it.each([
    ["missing", undefined],
    ["stopped", { ...running(), status: "Stopped" }],
  ])("reports confirmed loss of a %s instance during control cleanup", async (_kind, instance) => {
    const fake = new FakeIncus(() => ({ stderr: "desktop broke", code: 1 }));
    fake.instances.set("box", running());
    const provider = providerFor(fake);
    fake.onRead = () => {
      if (fake.execs.length) {
        if (instance) fake.instances.set("box", instance);
        else fake.instances.delete("box");
      }
    };
    await expect(
      provider.setScreenControl(computer, false, context, "control-token"),
    ).rejects.toMatchObject({ name: "SandboxNotFoundError" });
  });

  it("does not report a desktop error on a running instance as loss", async () => {
    const fake = new FakeIncus(() => ({ stderr: "desktop broke", code: 1 }));
    fake.instances.set("box", running());
    await expect(
      providerFor(fake).setScreenControl(computer, false, context, "control-token"),
    ).rejects.toThrow("desktop broke");
  });

  it("describes contract and capabilities", () => {
    expect(providerFor().describe()).toMatchObject({
      id: "incus",
      contractVersion: "1",
      capabilities: {
        graphical: true,
        pty: true,
        takeover: true,
        persistentHome: false,
        multiScreen: true,
      },
    });
  });
});

describe("ociImageSource", () => {
  it.each([
    ["ghcr.io/elie222/rakazo/computer:edge", "https://ghcr.io", "elie222/rakazo/computer:edge"],
    [
      "registry.example.test:5000/computer@sha256:abc",
      "https://registry.example.test:5000",
      "computer@sha256:abc",
    ],
    ["localhost/computer:dev", "https://localhost", "computer:dev"],
    ["example/computer:v1", "https://docker.io", "example/computer:v1"],
  ])("splits %s", (image, server, alias) => {
    expect(ociImageSource(image)).toEqual({ server, alias });
  });
});

describe("incusTlsOptions", () => {
  // Any well-formed certificate does; Node ships these.
  const certificate = rootCertificates[0]!;

  it("authenticates with the client certificate and verifies the server normally", () => {
    expect(incusTlsOptions({ clientCert: "cert", clientKey: "key" })).toEqual({
      cert: "cert",
      key: "key",
    });
  });

  it("trusts exactly the configured server certificate, whatever its names", () => {
    const options = incusTlsOptions({
      clientCert: "cert",
      clientKey: "key",
      serverCert: certificate,
    });
    expect(options.ca).toBe(certificate);
    const peer = (raw: Buffer) => ({ raw }) as PeerCertificate;
    const raw = new X509Certificate(certificate).raw;
    expect(options.checkServerIdentity?.("10.0.0.1", peer(raw))).toBeUndefined();
    expect(options.checkServerIdentity?.("10.0.0.1", peer(Buffer.from("other")))).toBeInstanceOf(
      Error,
    );
  });

  it("rejects a malformed server certificate at startup", () => {
    expect(() =>
      incusTlsOptions({ clientCert: "cert", clientKey: "key", serverCert: "not a certificate" }),
    ).toThrow();
  });
});
