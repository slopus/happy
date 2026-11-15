import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PortableFile, SandboxProvider, StreamedPortableFile } from "@rakazo/adapter-kit";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  fakeBoatProvider as fakeBoat,
  routeFakeBoatDownloads,
} from "./boat-sandbox.test-support.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { HostComputerSandbox } from "./host-computer-sandbox.js";
import { startHostComputerServer } from "./host-computer-server.js";
import { provisionPrepared } from "./sandbox-test-support.js";

let restoreFetch: () => void;
beforeAll(() => {
  restoreFetch = routeFakeBoatDownloads();
});
afterAll(() => restoreFetch());

const context = {
  operationId: "sandbox-fault-test",
  traceId: "sandbox-fault-test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

const temporaryRoots: string[] = [];
const hostServers: Array<Awaited<ReturnType<typeof startHostComputerServer>>> = [];

afterEach(async () => {
  await Promise.all(hostServers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.each([
  [
    "native host bridge",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "rakazo-host-contract-"));
      temporaryRoots.push(root);
      const token = "ab".repeat(32);
      const server = await startHostComputerServer({
        root: await realpath(root),
        token,
        hostname: "127.0.0.1",
      });
      hostServers.push(server);
      server.setEnabled(true);
      return new HostComputerSandbox(`http://127.0.0.1:${server.port}`, token);
    },
  ],
  ["fake", () => Promise.resolve(new FakeSandboxProvider())],
  ["Boat over a fake API", () => Promise.resolve(fakeBoat())],
  [
    "desktop",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "rakazo-sandbox-faults-"));
      temporaryRoots.push(root);
      return new DesktopSandboxProvider({ root: await realpath(root) });
    },
  ],
] as const)("%s sandbox negative contract", (_name, makeProvider) => {
  it("rejects traversal through every portable workspace entry point", async () => {
    const provider = await makeProvider();
    const computer = await provisionPrepared(
      provider,
      {
        botId: "traversal",
        homePath: "/unused",
      },
      context,
    );
    const escapingFile = {
      path: "safe/../../outside.txt",
      content: new TextEncoder().encode("nope"),
    };

    await expect(provider.listFiles(computer, "../outside", context)).rejects.toThrow(
      /escapes the computer workspace/i,
    );
    await expect(provider.readFile(computer, "..\\outside.txt", context)).rejects.toThrow(
      /escapes the computer workspace/i,
    );
    await expect(provider.writeFile(computer, escapingFile, context)).rejects.toThrow(
      /escapes the computer workspace/i,
    );
    await expect(
      provider.importWorkspace(computer, portableFiles([escapingFile]), context),
    ).rejects.toThrow(/escapes the computer workspace/i);
  });

  it("reports missing and oversized reads without returning partial data", async () => {
    const provider = await makeProvider();
    const computer = await provisionPrepared(
      provider,
      { botId: "reads", homePath: "/unused" },
      context,
    );
    await provider.writeFile(
      computer,
      { path: "payload.bin", content: Uint8Array.from([0, 1, 2, 3, 255]) },
      context,
    );

    await expect(provider.readFile(computer, "missing.bin", context)).rejects.toThrow(
      /not found|no such file/i,
    );
    await expect(
      provider.readFile(computer, "payload.bin", context, { maxBytes: 4 }),
    ).rejects.toThrow("computer file exceeds 4 bytes");
    expect(
      await provider.readFile(computer, "payload.bin", context, {
        maxBytes: 5,
      }),
    ).toEqual(Uint8Array.from([0, 1, 2, 3, 255]));
  });

  it("rejects oversized action batches before applying any action", async () => {
    const provider = await makeProvider();
    const computer = await provisionPrepared(
      provider,
      {
        botId: "actions",
        homePath: "/unused",
      },
      context,
    );
    if (provider instanceof HostComputerSandbox) {
      await expect(provider.observe()).rejects.toThrow("Local screen control is unavailable");
      await expect(provider.act()).rejects.toThrow("Local screen control is unavailable");
      return;
    }
    const before = await provider.observe(computer, context);

    await expect(
      provider.act(
        computer,
        {
          actions: Array.from({ length: 25 }, (_, index) => ({
            kind: "clipboard" as const,
            text: `action-${index}`,
          })),
          observe: true,
        },
        context,
      ),
    ).rejects.toThrow("computer action batch exceeds 24 actions");
    expect((await provider.observe(computer, context)).activeWindow).toEqual(before.activeWindow);
  });

  it("stops idempotently and reports whether provisioning reuses workspace files", async () => {
    const provider = await makeProvider();
    const request = { botId: "lifecycle", homePath: "/unused" };
    const first = await provisionPrepared(provider, request, context);
    await provider.writeFile(
      first,
      { path: "state.txt", content: new TextEncoder().encode("preserved") },
      context,
    );

    await provider.stop(first, context);
    await provider.stop(first, context);
    const reconnect = { ...request, providerRef: first.providerRef, providerKind: first.kind };
    const resumed = await provisionPrepared(provider, reconnect, context);
    expect(resumed).toMatchObject({
      id: first.id,
      providerRef: first.providerRef,
      fresh: false,
    });
    expect(new TextDecoder().decode(await provider.readFile(resumed, "state.txt", context))).toBe(
      "preserved",
    );

    await provider.destroy(resumed, context);
    await provider.destroy(resumed, context);
    const replacement = await provisionPrepared(provider, reconnect, context);
    if (provider instanceof DesktopSandboxProvider || provider instanceof HostComputerSandbox) {
      // A configured desktop root retains its workspace through destroy.
      expect(replacement.fresh).toBe(false);
      expect(
        new TextDecoder().decode(await provider.readFile(replacement, "state.txt", context)),
      ).toBe("preserved");
    } else {
      expect(replacement.fresh).toBe(true);
      await expect(provider.readFile(replacement, "state.txt", context)).rejects.toThrow(
        /not found/i,
      );
    }
    await provider.destroy(replacement, context);
  });

  it("surfaces injected lifecycle and transfer failures and remains retryable", async () => {
    const provider = await makeProvider();
    const faulted = faultOnce(provider, [
      "provision",
      "prepare",
      "importWorkspace",
      "exportWorkspace",
    ]);
    const request = { botId: "faults", homePath: "/unused" };

    await expect(faulted.provision(request, context)).rejects.toThrow("injected provision failure");
    const computer = await faulted.provision(request, context);
    expect(computer.fresh).toBe(true);
    await expect(faulted.prepare(computer, context)).rejects.toThrow("injected prepare failure");
    await faulted.prepare(computer, context);

    const file = {
      path: "retry.bin",
      content: Uint8Array.from([0, 255, 128, 1]),
      executable: true,
    };
    await expect(faulted.importWorkspace(computer, portableFiles([file]), context)).rejects.toThrow(
      "injected importWorkspace failure",
    );
    await faulted.importWorkspace(computer, portableFiles([file]), context);

    await expect(collect(faulted.exportWorkspace(computer, context))).rejects.toThrow(
      "injected exportWorkspace failure",
    );
    const exported = await collect(faulted.exportWorkspace(computer, context));
    expect(exported).toEqual([file]);
  });
});

describe("portable workspace transfer", () => {
  it("preserves binary bytes and executable metadata across every provider pairing", async () => {
    const sourceProviders = await providerSet("source");
    const targetProviders = await providerSet("target");
    const binary = Uint8Array.from([0, 255, 1, 128, 2, 127]);

    for (const [sourceName, source] of sourceProviders) {
      const sourceComputer = await provisionPrepared(
        source,
        {
          botId: `source-${sourceName}`,
          homePath: "/unused",
        },
        context,
      );
      await source.writeFile(
        sourceComputer,
        { path: "bin/tool", content: binary, executable: true },
        context,
      );
      const exported = await collect(source.exportWorkspace(sourceComputer, context));

      for (const [targetName, target] of targetProviders) {
        const targetComputer = await provisionPrepared(
          target,
          {
            botId: `${sourceName}-to-${targetName}`,
            homePath: "/unused",
          },
          context,
        );
        await target.importWorkspace(targetComputer, portableFiles(exported), context);

        expect(await target.readFile(targetComputer, "bin/tool", context)).toEqual(binary);
        expect(await target.listFiles(targetComputer, "bin", context)).toEqual([
          {
            path: "bin/tool",
            kind: "file",
            size: binary.byteLength,
            executable: true,
          },
        ]);
      }
    }
  });
});

type FaultableMethod = "provision" | "prepare" | "importWorkspace" | "exportWorkspace";

function faultOnce(provider: SandboxProvider, methods: FaultableMethod[]): SandboxProvider {
  const pending = new Set(methods);
  return new Proxy(provider, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (
        property !== "provision" &&
        property !== "prepare" &&
        property !== "importWorkspace" &&
        property !== "exportWorkspace"
      ) {
        return value.bind(target);
      }
      return (...args: unknown[]) => {
        if (!pending.delete(property)) return Reflect.apply(value, target, args);
        const error = new Error(`injected ${property} failure`);
        if (property !== "exportWorkspace") return Promise.reject(error);
        return {
          [Symbol.asyncIterator]() {
            return { next: () => Promise.reject(error) };
          },
        } satisfies AsyncIterable<PortableFile>;
      };
    },
  });
}

async function providerSet(label: string): Promise<Array<[string, SandboxProvider]>> {
  const root = await mkdtemp(path.join(tmpdir(), `rakazo-sandbox-transfer-${label}-`));
  temporaryRoots.push(root);
  return [
    ["fake", new FakeSandboxProvider()],
    ["boat", fakeBoat()],
    ["desktop", new DesktopSandboxProvider({ root: await realpath(root) })],
  ];
}

async function* portableFiles(files: Iterable<PortableFile>): AsyncIterable<PortableFile> {
  yield* files;
}

async function collect(
  files: AsyncIterable<PortableFile | StreamedPortableFile>,
): Promise<PortableFile[]> {
  const collected: PortableFile[] = [];
  for await (const file of files) {
    if (!("body" in file)) {
      collected.push(file);
      continue;
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of file.body) chunks.push(chunk);
    collected.push({
      path: file.path,
      content: Buffer.concat(chunks),
      executable: file.executable,
    });
  }
  return collected;
}
