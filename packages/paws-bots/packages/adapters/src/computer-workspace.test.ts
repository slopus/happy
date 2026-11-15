import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandRequest, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { SandboxDamagedError } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import * as Logging from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkpointAndStopComputer,
  checkpointComputerWorkspace,
  checkpointRunComputerWorkspace,
  deletedTeamBotFolders,
  ensureComputerWorkspaceLayout,
  PORTABLE_TRANSFER_BATCH_BYTES,
  PortableFileBatcher,
  removeComputerWorkspaceDirectories,
  removeDeletedBotWorkspaces,
  restoreComputerWorkspace,
  shouldSkipPortableWorkspaceFile,
  teamBrowserProfileName,
  WORKSPACE_SAVE_LIMITS,
} from "./computer-workspace.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";

const context = {
  operationId: "workspace-test",
  traceId: "workspace-test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider-neutral computer workspace", () => {
  it("keeps signed-in browser state but not components the browser downloads again", () => {
    const profile = ".browser-profiles/chromium-bot-1";
    for (const kept of [
      "Local State",
      "Default/Cookies",
      "Default/Login Data",
      "Default/Extensions/abc/1.0/manifest.json",
      "Default/Service Worker/Database/CURRENT",
      "Default/Service Worker/ScriptCache/index",
      "HistorySearch/embeddings.db",
    ]) {
      expect(shouldSkipPortableWorkspaceFile(`${profile}/${kept}`)).toBe(false);
    }
    for (const skipped of [
      "optimization_guide_model_store/43/model.tflite",
      "component_crx_cache/abc",
      "WasmTtsEngine/1.0/bindings.wasm",
      "WidevineCdm/4.10/manifest.json",
      "Safe Browsing/UrlMalware.store",
      "BrowserMetrics-spare.pma",
      "Default/Service Worker/CacheStorage/abc/index",
    ]) {
      expect(shouldSkipPortableWorkspaceFile(`${profile}/${skipped}`)).toBe(true);
    }
    expect(shouldSkipPortableWorkspaceFile("project/WidevineCdm/notes.txt")).toBe(false);
  });

  it("limits saves to 5 GiB and one million files", () => {
    expect(WORKSPACE_SAVE_LIMITS).toEqual({ maxBytes: 5 * 1024 ** 3, maxFiles: 1_000_000 });
  });

  it("skips dependencies and caches before counting a remote export", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-workspace-store-"));
    roots.push(root);
    const home = new LocalAgentHomeStore(root);
    const provider = new FakeSandboxProvider();
    const computer = await provider.provision(
      { botId: "cache-test", homePath: "/ignored" },
      context,
    );
    for (const file of [
      "project/node_modules/lib/data",
      ".cache/uv/data",
      "run.log",
      "packages/core/keep.txt",
    ]) {
      await provider.writeFile(computer, { path: file, content: Buffer.from("ok") }, context);
    }
    await checkpointComputerWorkspace(home, provider, "cache-test", computer, context, undefined, {
      maxBytes: 2,
      maxFiles: 1,
    });
    const files = [];
    for await (const file of home.exportHome("cache-test", context)) files.push(file.path);
    expect(files).toEqual(["packages/core/keep.txt"]);
  });

  it("prepares shared and bot folders for a Team Computer", async () => {
    const provider = new FakeSandboxProvider();
    const computer = await provider.provision(
      { botId: "team-workspace", homePath: "/ignored" },
      context,
    );
    const execute = vi.spyOn(provider, "execute");

    await ensureComputerWorkspaceLayout(provider, computer, "team", "bot-1", context);

    expect(execute).toHaveBeenCalledWith(
      computer,
      { argv: ["mkdir", "-p", "shared", "bots/bot-1"] },
      context,
    );
  });

  it("leaves deleted bots' folders and browser profiles out of a Team Computer checkpoint", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-workspace-store-"));
    roots.push(root);
    const home = new LocalAgentHomeStore(root);
    const provider = new FakeSandboxProvider();
    const computer = await provider.provision({ botId: "team", homePath: "/ignored" }, context);
    for (const file of [
      "bots/gone/notes.txt",
      `.browser-profiles/${teamBrowserProfileName("gone")}/Cookies`,
      "bots/gone-too/notes.txt",
      "bots/kept/notes.txt",
      `.browser-profiles/${teamBrowserProfileName("kept")}/Cookies`,
      "shared/bots/gone/plan.txt",
    ]) {
      await provider.writeFile(
        computer,
        { path: file, content: new TextEncoder().encode(file) },
        context,
      );
    }
    const deleted = [{ id: "gone" }];
    const findMany = vi.fn(async () => deleted);
    // A bot deleted while the export is in flight is left out too.
    const exportWorkspace = provider.exportWorkspace.bind(provider);
    vi.spyOn(provider, "exportWorkspace").mockImplementation(async function* (...args) {
      yield* exportWorkspace(...args);
      deleted.push({ id: "gone-too" });
    });

    await checkpointComputerWorkspace(home, provider, "team", computer, context, {
      prisma: {
        botDeletion: { findMany },
        computer: {
          findFirst: async () => ({ state: "running", restorePending: false, screenGeneration: 0 }),
        },
      } as never,
      computer: { id: "computer-1", scope: "team", spaceId: "workspace" },
    });

    const saved: string[] = [];
    for await (const file of home.exportHome("team", context)) saved.push(file.path);
    expect(saved.sort()).toEqual(
      [
        `.browser-profiles/${teamBrowserProfileName("kept")}/Cookies`,
        "bots/kept/notes.txt",
        "shared/bots/gone/plan.txt",
      ].sort(),
    );
    expect(findMany).toHaveBeenCalledWith({
      where: { spaceId: "workspace" },
      select: { id: true },
    });
    await expect(
      deletedTeamBotFolders({ botDeletion: { findMany } } as never, {
        scope: "dedicated",
        spaceId: "workspace",
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    { when: "marked before", first: { restorePending: true }, exported: false },
    { when: "starting before", first: { state: "booting" }, exported: false },
    { when: "started during", second: { screenGeneration: 1 }, exported: true },
    { when: "marked before", first: { restorePending: true }, exported: false, kind: "docker" },
  ])(
    "saves nothing from a run's $kind computer $when the export",
    async ({ first, second, exported, kind = "fake" }) => {
      const root = await mkdtemp(path.join(tmpdir(), "rakazo-workspace-restoring-"));
      roots.push(root);
      const home = new LocalAgentHomeStore(root);
      const provider = new FakeSandboxProvider();
      const computer = {
        ...(await provider.provision({ botId: "bot-1", homePath: "/ignored" }, context)),
        // A Docker computer mounts the home, so its save only records a new revision.
        kind: kind as ComputerRef["kind"],
      };
      await provider.writeFile(computer, { path: "a.txt", content: Buffer.from("a") }, context);
      const exportWorkspace = vi.spyOn(provider, "exportWorkspace");
      const commit = vi.spyOn(home, "commit");
      const revise = vi.spyOn(home, "revise");
      const running = { state: "running", restorePending: false, screenGeneration: 0 };
      const findFirst = vi
        .fn()
        .mockResolvedValueOnce({ ...running, ...first })
        .mockResolvedValue({ ...running, ...second });
      const updateMany = vi.fn();

      await expect(
        checkpointRunComputerWorkspace(
          {
            sandbox: provider,
            home,
            prisma: {
              botDeletion: { findMany: async () => [] },
              computer: { findFirst, updateMany },
            } as never,
          },
          { id: "computer-1", homeKey: "bot-1", scope: "dedicated", spaceId: "workspace" },
          computer,
          context,
        ),
      ).resolves.toBeUndefined();
      expect(exportWorkspace).toHaveBeenCalledTimes(exported ? 1 : 0);
      expect(commit).not.toHaveBeenCalled();
      expect(revise).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it("restores a checkpoint into a replacement provider machine", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-workspace-store-"));
    roots.push(root);
    const home = new LocalAgentHomeStore(root);
    const firstProvider = new FakeSandboxProvider();
    const first = await firstProvider.provision({ botId: "bot-1", homePath: "/ignored" }, context);

    await firstProvider.writeFile(
      first,
      { path: "notes/result.txt", content: new TextEncoder().encode("portable") },
      context,
    );
    const revision = await checkpointComputerWorkspace(
      home,
      firstProvider,
      "bot-1",
      first,
      context,
    );

    const replacementProvider = new FakeSandboxProvider();
    const replacement = await replacementProvider.provision(
      { botId: "bot-1", homePath: "/different-provider" },
      context,
    );
    await restoreComputerWorkspace(home, replacementProvider, "bot-1", replacement, context);

    expect(revision).toMatch(/^rev-/);
    expect(
      new TextDecoder().decode(
        await replacementProvider.readFile(replacement, "notes/result.txt", context),
      ),
    ).toBe("portable");
  });
});

describe("mounted Kubernetes homes", () => {
  function kubernetesSandbox(persistentHome: boolean, mountedHome = persistentHome) {
    const importWorkspace = vi.fn(async () => undefined);
    const exportWorkspace = vi.fn(async function* () {});
    const sandbox = {
      describe: () => ({
        id: "kubernetes",
        contractVersion: "1",
        adapterVersion: "test",
        capabilities: {
          graphical: true,
          pty: true,
          snapshots: true,
          takeover: true,
          persistentHome,
          multiScreen: true,
        },
      }),
      hasMountedHome: vi.fn(async () => mountedHome),
      importWorkspace,
      exportWorkspace,
    } as unknown as SandboxProvider;
    return { sandbox, importWorkspace, exportWorkspace };
  }
  const computer: ComputerRef = {
    id: "pod",
    botId: "bot-1",
    kind: "kubernetes",
    providerRef: "pod",
  };

  it("skips the copy when the pod mounts the local home", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-workspace-store-"));
    roots.push(root);
    const home = new LocalAgentHomeStore(root);
    const { sandbox, importWorkspace, exportWorkspace } = kubernetesSandbox(true);

    await restoreComputerWorkspace(home, sandbox, "bot-1", computer, context);
    const revision = await checkpointComputerWorkspace(home, sandbox, "bot-1", computer, context);

    expect(importWorkspace).not.toHaveBeenCalled();
    expect(exportWorkspace).not.toHaveBeenCalled();
    expect(revision).toMatch(/^rev-/);
  });

  it("saves a legacy pod even after persistent homes have been enabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-workspace-store-"));
    roots.push(root);
    const home = new LocalAgentHomeStore(root);
    const { sandbox, exportWorkspace } = kubernetesSandbox(true, false);
    exportWorkspace.mockImplementation(async function* () {
      yield { path: "latest.txt", content: Buffer.from("latest bytes") };
    } as never);
    await checkpointComputerWorkspace(home, sandbox, "bot-1", computer, context);
    expect(await home.readFile("bot-1", "latest.txt", context)).toBe("latest bytes");
    expect(exportWorkspace).toHaveBeenCalledOnce();
  });

  it("copies the home in and out when the pod has no mounted home", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-workspace-store-"));
    roots.push(root);
    const home = new LocalAgentHomeStore(root);
    const { sandbox, importWorkspace, exportWorkspace } = kubernetesSandbox(false);

    await restoreComputerWorkspace(home, sandbox, "bot-1", computer, context);
    await checkpointComputerWorkspace(home, sandbox, "bot-1", computer, context);

    expect(importWorkspace).toHaveBeenCalledOnce();
    expect(exportWorkspace).toHaveBeenCalledOnce();
  });
});

describe("Team run checkpoints", () => {
  it("keeps a mounted team home running while recording a checkpoint", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-mounted-checkpoint-"));
    roots.push(root);
    const home = new LocalAgentHomeStore(root);
    const exportWorkspace = vi.fn();
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const deps = {
      home,
      sandbox: { hasMountedHome: async () => true, exportWorkspace },
      prisma: {
        computer: {
          updateMany,
          findFirst: async () => ({ state: "running", restorePending: false, screenGeneration: 0 }),
        },
      },
    };
    const revision = await checkpointRunComputerWorkspace(
      deps as never,
      { id: "team", homeKey: "team", scope: "team", spaceId: "space" },
      { id: "pod", providerRef: "pod", kind: "kubernetes", botId: "team" },
      context,
    );
    expect(revision).toMatch(/^rev-/);
    expect(exportWorkspace).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: "team" },
      data: { homeRevision: revision, homeRevisionAt: expect.any(Date) },
    });
  });

  it("defers a remote export when another run prevents an exclusive checkpoint", async () => {
    const { checkpointRunComputerWorkspace } = await import("./computer-workspace.js");
    const exportWorkspace = vi.fn();
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const deps = {
      sandbox: { exportWorkspace },
      home: {},
      prisma: {
        computer: {
          updateMany,
          findFirst: async () => ({ state: "running", restorePending: false, screenGeneration: 0 }),
        },
        botDeletion: { findMany: async () => [] },
      },
    };
    const result = await checkpointRunComputerWorkspace(
      deps as never,
      { id: "team", homeKey: "team", scope: "team", spaceId: "workspace-1" },
      { id: "remote", providerRef: "remote", kind: "e2b", botId: "team" },
      { ...context, botId: "writer", screenLeaseId: "run-a:2" },
    );
    expect(result).toBeUndefined();
    expect(exportWorkspace).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: "running",
          executionLeases: {
            none: { expiresAt: { gt: expect.any(Date) }, NOT: { runId: "run-a", fence: 2 } },
          },
        }),
        data: expect.objectContaining({ state: "suspending" }),
      }),
    );
  });

  it("restores the running state when an exclusive remote export fails", async () => {
    const { checkpointRunComputerWorkspace } = await import("./computer-workspace.js");
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const exportWorkspace = vi.fn(async function* () {
      await Promise.reject(new Error("export failed"));
      yield { path: "unreachable", content: new Uint8Array() };
    });
    const deps = {
      sandbox: { exportWorkspace },
      home: {},
      prisma: {
        computer: {
          updateMany,
          findFirst: async () => ({ state: "running", restorePending: false, screenGeneration: 0 }),
        },
        botDeletion: { findMany: async () => [] },
      },
    };
    await expect(
      checkpointRunComputerWorkspace(
        deps as never,
        { id: "team", homeKey: "team", scope: "team", spaceId: "workspace-1" },
        { id: "remote", providerRef: "remote", kind: "boat", botId: "team" },
        { ...context, botId: "writer", screenLeaseId: "run-a:2" },
      ),
    ).rejects.toThrow("export failed");
    expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      exportWorkspace.mock.invocationCallOrder[0]!,
    );
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: "team", providerRef: "remote", state: "suspending" },
      data: { state: "running" },
    });
  });
});

describe("checkpointAndStopComputer", () => {
  const record = { id: "computer-1", homeKey: "home-1", scope: "dedicated", spaceId: "space-1" };
  const ref: ComputerRef = { id: "boat-1", providerRef: "boat-1", kind: "boat", botId: "home-1" };

  function sandboxFailingWith(error: Error) {
    return {
      // biome-ignore lint/correctness/useYield: the export fails before its first file
      exportWorkspace: async function* () {
        throw error;
      },
      stop: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("saves a healthy computer, then stops it as before", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const sandbox = { exportWorkspace: async function* () {}, stop };
    const commit = vi.fn().mockResolvedValue("revision-1");
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const deps = {
      sandbox,
      home: { commit },
      prisma: {
        computer: {
          updateMany,
          findFirst: async () => ({ state: "running", restorePending: false, screenGeneration: 0 }),
        },
      },
    };

    await checkpointAndStopComputer(deps as never, record, ref, context);

    expect(commit).toHaveBeenCalledOnce();
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1" },
      data: { homeRevision: "revision-1", homeRevisionAt: expect.any(Date) },
    });
    expect(stop.mock.calls).toEqual([[ref, context]]);
    expect(stop.mock.calls[0]).toHaveLength(2);
  });

  it("stops a damaged computer without its save", async () => {
    const sandbox = sandboxFailingWith(new SandboxDamagedError());
    const deps = {
      sandbox,
      home: {},
      prisma: {
        computer: {
          findFirst: async () => ({ state: "running", restorePending: false, screenGeneration: 0 }),
        },
      },
    };

    await checkpointAndStopComputer(deps as never, record, ref, context);

    expect(sandbox.stop).toHaveBeenCalledWith(ref, context, { discardUnsaved: true });
  });

  it("leaves a computer whose save fails for another reason running", async () => {
    const sandbox = sandboxFailingWith(new Error("export failed"));
    const deps = {
      sandbox,
      home: {},
      prisma: {
        computer: {
          findFirst: async () => ({ state: "running", restorePending: false, screenGeneration: 0 }),
        },
      },
    };

    await expect(checkpointAndStopComputer(deps as never, record, ref, context)).rejects.toThrow(
      "export failed",
    );
    expect(sandbox.stop).not.toHaveBeenCalled();
  });
});

describe("Team bot folder cleanup", () => {
  const computer: ComputerRef = {
    id: "sandbox-1",
    botId: "team-workspace",
    kind: "createos",
    providerRef: "sandbox-1",
  };

  function deletedBots(...ids: string[]) {
    const findMany = vi.fn().mockResolvedValue(ids.map((id) => ({ id })));
    return { findMany, prisma: { botDeletion: { findMany } } as unknown as PrismaClient };
  }

  it("removes only folders of bots deleted from this space when a Team Computer wakes", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rakazo-team-wake-"));
    roots.push(workspace);
    await seedFile(workspace, "bots/deleted-bot/private.txt", "gone");
    await seedFile(workspace, "bots/deleted-bot-2/notes.txt", "keep");
    await seedFile(workspace, "bots/live-bot/notes.txt", "keep");
    await seedFile(workspace, "shared/plan.txt", "keep");
    const { findMany, prisma } = deletedBots("deleted-bot", "never-had-a-folder");

    await removeDeletedBotWorkspaces(
      { prisma, sandbox: localWorkspaceSandbox(workspace) },
      computer,
      "workspace",
      context,
    );

    expect(findMany).toHaveBeenCalledWith({
      where: { spaceId: "workspace" },
      select: { id: true },
    });
    await expect(access(path.join(workspace, "bots", "deleted-bot"))).rejects.toThrow();
    for (const kept of [
      "bots/deleted-bot-2/notes.txt",
      "bots/live-bot/notes.txt",
      "shared/plan.txt",
    ]) {
      await expect(readFile(path.join(workspace, kept), "utf8")).resolves.toBe("keep");
    }
  });

  it("removes deleted bots' browser profiles when a Team Computer wakes", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rakazo-team-wake-profile-"));
    roots.push(workspace);
    const deletedProfile = `.browser-profiles/${teamBrowserProfileName("deleted-bot")}`;
    const liveProfile = `.browser-profiles/${teamBrowserProfileName("live-bot")}`;
    await seedFile(workspace, `${deletedProfile}/Cookies`, "gone");
    await seedFile(workspace, `${liveProfile}/Cookies`, "keep");
    const { prisma } = deletedBots("deleted-bot");

    await removeDeletedBotWorkspaces(
      { prisma, sandbox: localWorkspaceSandbox(workspace) },
      computer,
      "workspace",
      context,
    );

    await expect(access(path.join(workspace, deletedProfile))).rejects.toThrow();
    await expect(readFile(path.join(workspace, liveProfile, "Cookies"), "utf8")).resolves.toBe(
      "keep",
    );
  });

  it("unlinks a deleted bot's symlink that the provider's file listing does not show", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rakazo-team-wake-link-"));
    roots.push(workspace);
    await seedFile(workspace, "shared/plan.txt", "keep");
    await mkdir(path.join(workspace, "bots"));
    await symlink("../shared", path.join(workspace, "bots", "deleted-bot"));
    const sandbox = localWorkspaceSandbox(workspace);
    const listFiles = vi.fn().mockResolvedValue([]);
    const { prisma } = deletedBots("deleted-bot");

    await removeDeletedBotWorkspaces(
      { prisma, sandbox: { ...sandbox, listFiles } as unknown as SandboxProvider },
      computer,
      "workspace",
      context,
    );

    expect(listFiles).not.toHaveBeenCalled();
    await expect(lstat(path.join(workspace, "bots", "deleted-bot"))).rejects.toThrow();
    await expect(readFile(path.join(workspace, "shared/plan.txt"), "utf8")).resolves.toBe("keep");
  });

  it("keeps removing deleted bots' folders after one entry is refused", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rakazo-team-wake-refused-"));
    roots.push(workspace);
    await seedFile(workspace, "bots/deleted-a", "not a folder");
    await seedFile(workspace, "bots/deleted-b/private.txt", "gone");
    const { prisma } = deletedBots("deleted-a", "deleted-b");

    await removeDeletedBotWorkspaces(
      { prisma, sandbox: localWorkspaceSandbox(workspace) },
      computer,
      "workspace",
      context,
    );

    await expect(readFile(path.join(workspace, "bots/deleted-a"), "utf8")).resolves.toBe(
      "not a folder",
    );
    await expect(access(path.join(workspace, "bots", "deleted-b"))).rejects.toThrow();
  });

  it("removes a deleted bot's folder that holds Go's read-only module cache", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rakazo-team-wake-readonly-"));
    roots.push(workspace);
    const module = path.join(workspace, "bots/deleted-bot/go/pkg/mod/example.com/m@v1.0.0");
    await mkdir(path.join(workspace, "outside"), { mode: 0o555 });
    await seedFile(module, "go.mod", "module example.com/m\n");
    await symlink(path.join(workspace, "outside"), path.join(module, "outside"));
    await chmod(module, 0o555);
    await chmod(path.dirname(module), 0o555);

    await removeComputerWorkspaceDirectories(
      localWorkspaceSandbox(workspace),
      computer,
      "bots",
      ["deleted-bot"],
      context,
    );

    await expect(access(path.join(workspace, "bots", "deleted-bot"))).rejects.toThrow();
    expect((await stat(path.join(workspace, "outside"))).mode & 0o777).toBe(0o555);
  });

  it("leaves the mode of a file the deleted bot's folder links to", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rakazo-team-wake-hardlink-"));
    roots.push(workspace);
    await seedFile(workspace, "shared/keep.txt", "keep");
    await chmod(path.join(workspace, "shared/keep.txt"), 0o444);
    await mkdir(path.join(workspace, "bots/deleted-bot"), { recursive: true });
    await link(
      path.join(workspace, "shared/keep.txt"),
      path.join(workspace, "bots/deleted-bot/keep.txt"),
    );

    await removeComputerWorkspaceDirectories(
      localWorkspaceSandbox(workspace),
      computer,
      "bots",
      ["deleted-bot"],
      context,
    );

    await expect(access(path.join(workspace, "bots", "deleted-bot"))).rejects.toThrow();
    expect((await stat(path.join(workspace, "shared/keep.txt"))).mode & 0o777).toBe(0o444);
  });

  it("does not look up deletions when the Team Computer has no bot folders", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rakazo-team-wake-empty-"));
    roots.push(workspace);
    await mkdir(path.join(workspace, "bots"));
    await mkdir(path.join(workspace, ".browser-profiles"));
    const { findMany, prisma } = deletedBots("deleted-bot");

    await removeDeletedBotWorkspaces(
      { prisma, sandbox: localWorkspaceSandbox(workspace) },
      computer,
      "workspace",
      context,
    );

    expect(findMany).not.toHaveBeenCalled();
  });

  it("reaches the oldest leftover however long the deletion history is", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rakazo-team-wake-history-"));
    roots.push(workspace);
    await seedFile(workspace, "bots/oldest-bot/private.txt", "gone");
    await seedFile(workspace, "bots/live-bot/notes.txt", "keep");
    const history = Array.from({ length: 5_000 }, (_, index) => `deleted-${index}`);
    const { prisma } = deletedBots(...history, "oldest-bot");
    const sandbox = localWorkspaceSandbox(workspace);
    const execute = vi.spyOn(sandbox, "execute");

    await removeDeletedBotWorkspaces({ prisma, sandbox }, computer, "workspace", context);

    // One listing and one removal, instead of a command per batch of the whole history.
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith(
      computer,
      { argv: ["bash", "-eu", "-c", expect.any(String), "bash", "bots", "oldest-bot"], cwd: "." },
      expect.anything(),
    );
    await expect(access(path.join(workspace, "bots", "oldest-bot"))).rejects.toThrow();
    await expect(readFile(path.join(workspace, "bots/live-bot/notes.txt"), "utf8")).resolves.toBe(
      "keep",
    );
  });

  it("stops waiting for the cleanup once its time budget runs out, leaving the rest for the next boot", async () => {
    const { prisma } = deletedBots("deleted-bot");
    let commandSignal: AbortSignal | undefined;
    // Never finishes and ignores aborts, like a wedged provider call.
    const execute = vi.fn((_computer: ComputerRef, _request: CommandRequest, commandContext) => {
      commandSignal = (commandContext as typeof context).signal;
      return (async function* () {
        await new Promise(() => undefined);
        yield { type: "exit" as const, code: 0 };
      })();
    });

    await expect(
      removeDeletedBotWorkspaces(
        { prisma, sandbox: { execute } as unknown as SandboxProvider },
        computer,
        "workspace",
        context,
        20,
      ),
    ).resolves.toBeUndefined();
    expect(commandSignal?.aborted).toBe(true);
  });

  it("does not report a removal the cleanup deadline cut short as an error", async () => {
    const { prisma } = deletedBots("deleted-bot");
    const execute = vi.fn((_computer: ComputerRef, request: CommandRequest, commandContext) => {
      const { signal } = commandContext as typeof context;
      return (async function* () {
        if (!request.argv.includes("deleted-bot")) {
          yield { type: "stdout" as const, data: "bots/deleted-bot\n" };
          yield { type: "exit" as const, code: 0 };
          return;
        }
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        yield { type: "stderr" as const, data: "command aborted\n" };
        yield { type: "exit" as const, code: 130 };
      })();
    });
    const warn = vi.fn();
    const error = vi.fn();
    const logger = vi.spyOn(Logging, "getLogger").mockReturnValue({ warn, error } as never);
    try {
      await removeDeletedBotWorkspaces(
        { prisma, sandbox: { execute } as unknown as SandboxProvider },
        computer,
        "workspace",
        context,
        20,
      );
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      logger.mockRestore();
    }
    expect(warn).toHaveBeenCalledWith("computer cleanup ran out of time");
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    ["bots", ".."],
    ["bots", "../shared"],
    ["bots", "."],
    ["shared", "plan"],
  ])("refuses to remove %s/%s", async (parent, name) => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rakazo-team-escape-"));
    roots.push(workspace);
    await seedFile(workspace, "shared/plan/notes.txt", "keep");
    await mkdir(path.join(workspace, "bots"));

    await expect(
      removeComputerWorkspaceDirectories(
        localWorkspaceSandbox(workspace),
        computer,
        parent as "bots",
        [name],
        context,
      ),
    ).rejects.toThrow("folder escapes the team home");
    await expect(readFile(path.join(workspace, "shared/plan/notes.txt"), "utf8")).resolves.toBe(
      "keep",
    );
  });
});

async function seedFile(root: string, relative: string, content: string) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

/** Runs commands in a local folder that stands in for the computer's workspace. */
function localWorkspaceSandbox(workspace: string) {
  return {
    execute: async function* (_computer: ComputerRef, request: CommandRequest) {
      try {
        const stdout = execFileSync(request.argv[0] ?? "bash", request.argv.slice(1), {
          cwd: workspace,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (stdout) yield { type: "stdout" as const, data: stdout };
        yield { type: "exit" as const, code: 0 };
      } catch (error) {
        const failed = error as { status?: number; stderr?: Buffer };
        yield { type: "stderr" as const, data: failed.stderr?.toString() ?? "" };
        yield { type: "exit" as const, code: failed.status ?? 1 };
      }
    },
  } as unknown as SandboxProvider;
}

describe("PortableFileBatcher", () => {
  it("hands back a batch once a file would pass the file count or the byte budget", () => {
    const batcher = new PortableFileBatcher<number>(2, (size) => size);
    const sent = [1, 2, 3, PORTABLE_TRANSFER_BATCH_BYTES, 4].map((size) => batcher.add(size));
    expect(sent).toEqual([undefined, undefined, [1, 2], [3], [PORTABLE_TRANSFER_BATCH_BYTES]]);
    expect(batcher.take()).toEqual([4]);
    expect(batcher.take()).toEqual([]);
  });

  it("hands back an empty batch when an oversized file comes first", () => {
    const batcher = new PortableFileBatcher<number>(8, (size) => size);
    expect(batcher.add(PORTABLE_TRANSFER_BATCH_BYTES + 1)).toEqual([]);
    expect(batcher.take()).toEqual([PORTABLE_TRANSFER_BATCH_BYTES + 1]);
  });
});
