import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RPCHandler } from "@orpc/server/fetch";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { FakeSandboxProvider, LocalAgentHomeStore, provisionComputer } from "@rakazo/adapters";
import type * as Db from "@rakazo/db";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

// The plan's size is read from billing, which these Prisma doubles do not model.
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  planComputerSize: vi.fn(async () => "standard"),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Stop during a computer reconnect", () => {
  it.each([false, true])(
    "refuses an in-flight reconnect (stale Stop read: %s)",
    async (staleRead) => {
      const dataDir = await mkdtemp(path.join(tmpdir(), "computer-stop-"));
      const context = {
        operationId: "reconnect",
        traceId: "test",
        spaceId: "space",
        userId: "user",
        botId: "bot",
        signal: new AbortController().signal,
      } satisfies AdapterContext;
      const sandbox = new FakeSandboxProvider();
      const ref = await sandbox.provision({ botId: "home", homePath: dataDir }, context);
      const row = {
        id: "computer",
        spaceId: "space",
        userId: "user",
        homeKey: "home",
        kind: ref.kind,
        providerRef: ref.providerRef,
        scope: "dedicated",
        state: "running",
        controlHolder: "none",
        controlLeaseId: null,
        maintenanceId: null,
        screenGeneration: 1,
        updatedAt: new Date(0),
      };
      const beforeBoot = { ...row };
      // Simulate an unavailable status probe: reuse must fall back to reconnecting.
      vi.spyOn(sandbox, "isRunning").mockRejectedValue(new Error("status unavailable"));
      const entered = deferred();
      const resume = deferred();
      const provision = sandbox.provision.bind(sandbox);
      vi.spyOn(sandbox, "provision").mockImplementation(async (request, ctx) => {
        entered.resolve();
        await resume.promise;
        return provision(request, ctx);
      });
      const stop = vi.spyOn(sandbox, "stop");
      const prisma = {
        spaceMember: { count: vi.fn(async () => 1) },
        bot: {
          findFirst: vi.fn(async () => ({
            id: "bot",
            spaceId: "space",
            userId: "user",
            thread: { id: "thread" },
            computer: staleRead && row.state === "booting" ? { ...beforeBoot } : { ...row },
          })),
        },
        computer: {
          findUniqueOrThrow: vi.fn(async () => ({ ...row })),
          findFirst: vi.fn(async () => ({
            state: "running",
            restorePending: false,
            screenGeneration: 0,
          })),
          updateMany: vi.fn(async ({ where, data }) => {
            // Model the atomic scalar predicates, including the lifecycle claim stamp.
            for (const key of [
              "state",
              "providerRef",
              "kind",
              "updatedAt",
              "maintenanceId",
            ] as const) {
              if (!(key in where)) continue;
              if (key === "state" && typeof where.state === "object") {
                if (where.state.notIn.includes(row.state)) return { count: 0 };
              } else if (where[key] !== row[key]) return { count: 0 };
            }
            Object.assign(row, { updatedAt: new Date(row.updatedAt.getTime() + 1) }, data);
            return { count: 1 };
          }),
        },
        computerExecutionLease: {
          updateMany: vi.fn(async () => ({ count: 0 })),
          findUnique: vi.fn(async () => null),
        },
        computerRun: {
          updateMany: vi.fn(async () => ({ count: 0 })),
          createMany: vi.fn(async () => ({ count: 1 })),
        },
        run: { findFirst: vi.fn(async () => null) },
      } as unknown as PrismaClient;
      const deps = {
        prisma,
        sandbox,
        home: new LocalAgentHomeStore(dataDir),
        dataDir,
        jobs: { cancel: vi.fn(async () => undefined) },
        env: {
          defaultProvider: "fake",
          defaultModel: "fake-model",
          sandboxProvider: "fake",
          webOrigin: "https://web.example.test",
          screenProxySecret: "test-secret",
        },
      } as unknown as RouterDeps;
      const boot = provisionComputer(deps, row.id, context);
      // Attach both handlers before releasing the provider so failures are never unhandled.
      const bootResult = boot.then(
        () => null,
        (error: unknown) => error,
      );
      try {
        await entered.promise;
        expect(row.state).toBe("booting");
        const handler = new RPCHandler(createRouter(deps));
        const requestStop = async () => {
          const { response } = await handler.handle(
            new Request("https://api.example.test/rpc/computer/stop", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ json: { botId: "bot" } }),
            }),
            {
              prefix: "/rpc",
              context: {
                actor: {
                  userId: "user",
                  spaceId: "space",
                  email: "user@example.test",
                  isDeploymentOwner: false,
                },
              },
            },
          );
          if (!response) throw new Error("no response");
          return response;
        };
        const response = await requestStop();
        resume.resolve();
        const error = await bootResult;
        expect({
          status: response.status,
          state: row.state,
          running: sandbox.boxes.get(ref.id)?.running,
          bootError: error,
        }).toMatchObject({ status: 409, state: "running", running: true, bootError: null });
        expect(stop).not.toHaveBeenCalled();
        // Stop can succeed once the reconnect has finished; nothing resumes it afterward.
        const stopped = await requestStop();
        expect(stopped.status).toBe(200);
        expect(row.state).toBe("stopped");
        expect(sandbox.boxes.get(ref.id)?.running).toBe(false);
      } finally {
        resume.resolve();
        await bootResult;
        vi.restoreAllMocks();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );
});
