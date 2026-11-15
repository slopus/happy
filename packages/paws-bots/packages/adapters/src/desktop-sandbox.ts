import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
  WorkspaceDirectoryRequest,
} from "@rakazo/adapter-kit";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core";
import {
  applyPlaceholderAction,
  boundedComputerActions,
  normalizeWorkspacePath,
  placeholderObservation,
} from "./computer-support.js";
import type { NativeProcessTree } from "./desktop-process-tree.js";
import { spawnOwnedCommand } from "./desktop-process-tree.js";
import { isAllowedDesktopPath, normalizeDesktopWorkspacePath } from "./desktop-sandbox-paths.js";
import type { Win32FileHandle } from "./desktop-sandbox-win32-path.js";
import {
  createExclusiveChildViaDirectoryFdWin32,
  mkdirChildViaDirectoryFdWin32,
  openChildDirectoryViaDirectoryFdWin32,
  openExistingChildViaDirectoryFdWin32,
  pathFromDirectoryFd,
  win32NtRelativeAvailable,
} from "./desktop-sandbox-win32-path.js";
import { removeOwnedWorkspaceChildren } from "./desktop-workspace-cleanup.js";
import { hostCommandEnvironment } from "./sandbox-command-environment.js";
import { abortedCommandEvents } from "./sandbox-command-events.js";
import {
  isTaggedCacheDirectory,
  shouldSkipPortableWorkspaceFile,
} from "./workspace-save-policy.js";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * Bot commands run directly as this OS user, so a backend may select SANDBOX_PROVIDER=desktop
 * only inside the desktop app or a local development or test process. Server images set
 * NODE_ENV=production and must use an isolated provider.
 */
export function assertHostCommandsAllowed(
  env: NodeJS.ProcessEnv = process.env,
  versions: NodeJS.ProcessVersions = process.versions,
) {
  if (versions.electron || env.NODE_ENV === "development" || env.NODE_ENV === "test") return;
  throw new Error(
    "SANDBOX_PROVIDER=desktop runs bot commands directly on this host and is limited to local development. Use docker or a remote provider, or local computer access in the desktop app.",
  );
}

export function describeDesktopSandbox() {
  return {
    id: "desktop",
    contractVersion: "1",
    adapterVersion: "0.1.0",
    capabilities: {
      graphical: false,
      pty: true,
      snapshots: true,
      takeover: false,
      persistentHome: true,
      multiScreen: false,
    },
  };
}

/** Node FileHandle or Win32 duck-typed handle opened relative to a parent directory. */
type ContainedHandle = Awaited<ReturnType<typeof open>> | Win32FileHandle;

interface DesktopBox {
  ref: ComputerRef;
  home: string;
  screen: string;
}

/** Beside the home, not in it, so workspace listings, checkpoints and restores never carry it. */
function stoppedMarker(home: string) {
  return `${home}.stopped`;
}

async function markStopped(home: string) {
  // Without a parent folder there is no home either, which already reads as stopped.
  await writeFile(stoppedMarker(home), "").catch((error) => {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  });
}

export class DesktopSandboxProvider implements SandboxProvider {
  readonly boxes = new Map<string, DesktopBox>();
  private readonly processTrees = new Map<NativeProcessTree, { home: string; runId?: string }>();
  private processSweep?: NodeJS.Timeout;

  private sweepProcesses() {
    for (const tree of this.processTrees.keys()) {
      if (!tree.alive()) {
        tree.close();
        this.processTrees.delete(tree);
      }
    }
    if (!this.processTrees.size) {
      clearInterval(this.processSweep);
      this.processSweep = undefined;
    }
  }

  cancelAllCommands() {
    for (const tree of this.processTrees.keys()) {
      tree.kill();
      tree.close();
    }
    this.processTrees.clear();
    clearInterval(this.processSweep);
    this.processSweep = undefined;
  }

  async cancelRunWork(
    computer: ComputerRef,
    _computerId: string,
    runId: string,
    _context: AdapterContext,
  ) {
    const box = this.boxFor(computer);
    if (!box) return;
    this.cancelOwnedProcesses(box.home, runId);
  }

  private cancelOwnedProcesses(home: string, runId?: string) {
    for (const [tree, owner] of this.processTrees) {
      if (owner.home === home && (runId === undefined || owner.runId === runId)) {
        tree.kill();
        tree.close();
        this.processTrees.delete(tree);
      }
    }
    this.sweepProcesses();
  }

  constructor(
    private readonly opts: { root?: string; hostRoots?: string[]; maxFileBytes?: number } = {},
  ) {}

  describe() {
    return describeDesktopSandbox();
  }

  async provision(
    request: { botId: string; homePath: string },
    _context: AdapterContext,
  ): Promise<ComputerRef> {
    const home = this.homeFor(request.botId);
    await rm(stoppedMarker(home), { force: true });
    // Recursive mkdir returns undefined when the directory already exists. This
    // survives adapter/process restarts and distinguishes live files from a new home,
    // including a home removed under a box this process still holds.
    const fresh = (await mkdir(home, { recursive: true })) !== undefined;
    const existing = [...this.boxes.values()].find(
      (box) => box.ref.botId === request.botId || box.home === home,
    );
    if (existing) return { ...existing.ref, fresh };
    const id = `desktop-${request.botId}`;
    const ref: ComputerRef = {
      id,
      botId: request.botId,
      kind: "desktop",
      providerRef: home,
      fresh,
    };
    this.boxes.set(id, {
      ref,
      home,
      screen: "ready",
    });
    return ref;
  }

  async workspaceDirectories(
    computer: ComputerRef,
    request: WorkspaceDirectoryRequest,
    context: AdapterContext,
  ): Promise<string[]> {
    const { home } = this.requiredBox(computer);
    if (request.action === "ensure") {
      for (const directory of request.paths) {
        if (context.signal.aborted) throw context.signal.reason;
        // The existing contained parent walk creates directories without creating a marker file.
        await localWorkspaceTarget(
          home,
          `${normalizeDesktopWorkspacePath(directory)}/.directory`,
          false,
        );
      }
      return [];
    }
    const entries: string[] = [];
    const parents = request.action === "list" ? ["bots", ".browser-profiles"] : [request.parent];
    let refused = false;
    for (const parent of parents) {
      if (parent !== "bots" && parent !== ".browser-profiles")
        throw new Error("Path escapes the computer workspace");
      const pattern = parent === "bots" ? /^[A-Za-z0-9_-]+$/ : /^chromium-bot-[0-9a-f]{32}$/;
      const names =
        request.action === "remove"
          ? request.names.filter((name) => {
              if (pattern.test(name)) return true;
              refused = true;
              return false;
            })
          : [];
      const parentPath = path.join(home, parent);
      const info = await lstat(parentPath, { bigint: true }).catch((error) => {
        if (hasErrorCode(error, "ENOENT")) return null;
        throw error;
      });
      if (!info) continue;
      if (info.isSymbolicLink() || !info.isDirectory()) {
        if (request.action === "list") continue;
        throw new Error("Path escapes the computer workspace");
      }
      const target = await localWorkspaceTarget(home, parent, true);
      if (request.action === "list") {
        for (const name of await readdir(target)) entries.push(`${parent}/${name}`);
      } else if (request.action === "remove") {
        await removeOwnedWorkspaceChildren(target, names, info, context.signal);
      }
    }
    if (refused) throw new Error("Path escapes the computer workspace");
    return entries;
  }

  // Read from disk: the API and the worker each build their own provider over the same homes.
  // A missing home reads as stopped, so the caller reconnects and restores it.
  async isRunning(computer: ComputerRef, _context: AdapterContext) {
    const home = this.homeFor(computer.botId);
    if (!computer.providerRef || path.resolve(computer.providerRef) !== home) return false;
    const [info, stopped] = await Promise.all([
      stat(home).catch(() => undefined),
      // Only a missing marker means not stopped; any other failure must not read as running.
      lstat(stoppedMarker(home)).then(
        () => true,
        (error: unknown) => {
          if (hasErrorCode(error, "ENOENT")) return false;
          throw error;
        },
      ),
    ]);
    return Boolean(info?.isDirectory()) && !stopped;
  }

  async environment() {
    return {
      platform: process.platform,
      home: homedir(),
      shell: process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/sh",
    };
  }

  async prepare(_computer: ComputerRef, _context: AdapterContext): Promise<void> {}

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const box = this.boxFor(computer);
    if (!box) {
      yield { type: "stderr", data: "computer not found" };
      yield { type: "exit", code: 1 };
      return;
    }
    const cwd = resolveExecuteCwd(request.cwd, box.home);
    if (!isAllowedDesktopPath(cwd, this.allowedRoots(box.home))) {
      yield { type: "stderr", data: "path is outside this computer's home" };
      yield { type: "exit", code: 1 };
      return;
    }
    await mkdir(cwd, { recursive: true });
    const argv = request.argv.length ? request.argv : ["echo", "ready"];
    this.sweepProcesses();
    if (this.processTrees.size >= 256) throw new Error("Too many local background commands");
    yield* streamLocalCommand(
      argv,
      cwd,
      boundedSandboxCommandTimeoutMs(request.timeoutMs),
      context.signal,
      request,
      (tree) => {
        this.processTrees.set(tree, { home: box.home, runId: context.runId });
        if (!this.processSweep) {
          this.processSweep = setInterval(() => this.sweepProcesses(), 1000);
          this.processSweep.unref();
        }
      },
      () => this.sweepProcesses(),
    );
  }

  async connectScreen(
    computer: ComputerRef,
    _request: ScreenRequest,
    _context: AdapterContext,
  ): Promise<ScreenSession> {
    return {
      url: `desktop://screen/${computer.id}`,
      mimeType: "text/plain",
      close: async () => undefined,
    };
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    _context: AdapterContext,
  ): Promise<void> {
    const box = this.boxFor(computer);
    if (box) applyPlaceholderAction(box, input);
  }

  async observe(computer: ComputerRef) {
    return placeholderObservation(this.requiredBox(computer).screen);
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, _context: AdapterContext) {
    const box = this.requiredBox(computer);
    const actions = boundedComputerActions(request.actions);
    for (const action of actions) applyPlaceholderAction(box, action);
    return {
      completed: actions.length,
      ...(request.observe === false ? {} : { observation: await this.observe(computer) }),
    };
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    _context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const box = this.requiredBox(computer);
    const relative = normalizeWorkspacePath(directory);
    const target = await localWorkspaceTarget(box.home, relative, true);
    const entries = await readdir(target, { withFileTypes: true });
    const listed = await Promise.all(
      entries.map(async (entry) => {
        // A link that dangles or leaves the workspace is skipped, as in walkDesktopWorkspace.
        const child = await localWorkspaceTarget(
          box.home,
          relative ? `${relative}/${entry.name}` : entry.name,
          true,
        ).catch(() => null);
        if (!child) return null;
        const info = await stat(child);
        return {
          path: normalizeWorkspacePath(relative ? `${relative}/${entry.name}` : entry.name),
          kind: info.isDirectory() ? ("dir" as const) : ("file" as const),
          size: info.size,
          ...(info.isFile() && info.mode & 0o100 ? { executable: true } : {}),
        };
      }),
    );
    return listed.filter((entry) => entry !== null);
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    _context?: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const box = this.requiredBox(computer);
    const target = await localWorkspaceTarget(box.home, filePath, true);
    const info = await stat(target);
    if (options?.maxBytes !== undefined && info.size > options.maxBytes) {
      throw new Error(`computer file exceeds ${options.maxBytes} bytes`);
    }
    return new Uint8Array(await readFile(target));
  }

  async writeFile(computer: ComputerRef, file: PortableFile) {
    const box = this.requiredBox(computer);
    const target = await localWorkspaceTarget(box.home, file.path, false);
    const handle = await openContainedWorkspaceFile(
      box.home,
      target,
      file.executable ? 0o700 : 0o600,
    );
    try {
      await handle.truncate(0);
      await handle.writeFile(file.content);
      if (file.executable) await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
  }

  async *exportWorkspace(computer: ComputerRef): AsyncIterable<PortableFile> {
    const box = this.requiredBox(computer);
    yield* walkDesktopWorkspace(box.home, "", this.opts.maxFileBytes);
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    _context: AdapterContext,
  ) {
    for await (const file of files) {
      if (shouldSkipPortableWorkspaceFile(file.path)) continue;
      await this.writeFile(computer, file);
    }
  }

  async snapshot(computer: ComputerRef, _context: AdapterContext) {
    return { id: `desktop-snap-${computer.id}`, createdAt: new Date().toISOString() };
  }

  async stop(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const box = this.boxFor(computer);
    if (box) {
      this.cancelOwnedProcesses(box.home);
      await markStopped(box.home);
    }
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const box = this.boxFor(computer);
    if (box) {
      this.cancelOwnedProcesses(box.home);
      this.boxes.delete(box.ref.id);
    }
    this.boxes.delete(computer.id);
    if (box && this.opts.root) {
      // The home stays on disk, so record the stop or it would still read as running.
      await markStopped(box.home);
    }
    if (box && !this.opts.root) {
      await rm(box.home, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private homeFor(botId: string) {
    return path.resolve(
      this.opts.root ?? path.join(process.cwd(), "data"),
      "desktop-computers",
      botId,
    );
  }

  private boxFor(computer: ComputerRef): DesktopBox | undefined {
    const existing = this.boxes.get(computer.id);
    if (existing) return existing;
    for (const box of this.boxes.values()) {
      if (box.ref.botId === computer.botId || box.home === computer.providerRef) return box;
    }
    if (!computer.providerRef) return undefined;
    const box: DesktopBox = {
      ref: computer,
      home: path.resolve(computer.providerRef),
      screen: "ready",
    };
    this.boxes.set(computer.id, box);
    return box;
  }

  private requiredBox(computer: ComputerRef): DesktopBox {
    const box = this.boxFor(computer);
    if (!box) throw new Error("computer not found");
    return box;
  }

  private allowedRoots(home: string) {
    return [home, ...(this.opts.hostRoots ?? [])];
  }
}

async function localWorkspaceTarget(home: string, relative: string, mustExist: boolean) {
  const normalized = normalizeDesktopWorkspacePath(relative);
  const candidate = path.resolve(home, normalized);
  if (!isAllowedDesktopPath(candidate, [home]))
    throw new Error("Path escapes the computer workspace");
  const resolvedHome = await realpath(home);
  if (!mustExist) {
    // Walk/create parents from a held directory fd so a junction swap cannot
    // redirect mkdir outside the workspace between validation and creation.
    const segments = normalized.split(/[/\\]/u).filter(Boolean);
    let current = resolvedHome;
    let parentHandle: ContainedHandle = await open(
      current,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
    );
    const useWin32Relative = win32NtRelativeAvailable();
    try {
      for (const segment of segments.slice(0, -1)) {
        // Re-bind the held parent immediately before create so a junction swap cannot
        // redirect pathname mkdir outside the workspace.
        current = await assertContainedDirectoryHandle(parentHandle, current, resolvedHome);
        let created: { path: string; dev: number; ino: number } | undefined;
        try {
          if (useWin32Relative) {
            const createdPath = mkdirChildViaDirectoryFdWin32(parentHandle.fd, segment);
            if (createdPath) {
              const createdStat = await stat(createdPath).catch(() => undefined);
              if (createdStat?.isDirectory()) {
                created = { path: createdPath, dev: createdStat.dev, ino: createdStat.ino };
              }
            }
          } else {
            const viaDirFd = childPathViaDirFd(parentHandle.fd, segment);
            const next = viaDirFd ?? path.join(current, segment);
            await mkdir(next);
            const createdStat = await stat(next);
            created = { path: next, dev: createdStat.dev, ino: createdStat.ino };
          }
        } catch (error) {
          if (!hasErrorCode(error, "EEXIST")) throw error;
        }
        try {
          let nextHandle: ContainedHandle;
          let before: { dev: number; ino: number; isDirectory(): boolean };
          let resolved: string;
          if (useWin32Relative) {
            nextHandle = openChildDirectoryViaDirectoryFdWin32(parentHandle.fd, segment);
            before = await nextHandle.stat();
            if (!before.isDirectory()) {
              await nextHandle.close().catch(() => undefined);
              throw new Error("Path escapes the computer workspace");
            }
            resolved = await assertContainedDirectoryHandle(
              nextHandle,
              path.join(current, segment),
              resolvedHome,
              before,
            );
          } else {
            const viaDirFd = childPathViaDirFd(parentHandle.fd, segment);
            const next = viaDirFd ?? path.join(current, segment);
            resolved = await realpath(next);
            before = await stat(resolved);
            if (!isAllowedDesktopPath(resolved, [resolvedHome]) || !before.isDirectory()) {
              throw new Error("Path escapes the computer workspace");
            }
            nextHandle = await open(resolved, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
            try {
              // Re-resolve after open so a junction swap cannot leave us holding an
              // outside directory while still trusting the earlier inside pathname.
              resolved = await assertContainedDirectoryHandle(
                nextHandle,
                resolved,
                resolvedHome,
                before,
              );
            } catch (error) {
              await nextHandle.close().catch(() => undefined);
              throw error;
            }
          }
          current = resolved;
          await parentHandle.close().catch(() => undefined);
          parentHandle = nextHandle;
        } catch (error) {
          // Only remove the directory inode we created; a swapped pathname must not
          // rmdir a different empty directory.
          if (created) {
            const present = await stat(created.path).catch(() => undefined);
            if (present && present.dev === created.dev && present.ino === created.ino) {
              await rmdir(created.path).catch(() => undefined);
            }
          }
          throw error;
        }
      }
      return path.join(current, segments.at(-1) ?? "");
    } finally {
      await parentHandle.close().catch(() => undefined);
    }
  }
  const resolved = await realpath(candidate);
  if (!isAllowedDesktopPath(resolved, [resolvedHome]))
    throw new Error("Path escapes the computer workspace");
  return resolved;
}

async function openContainedWorkspaceFile(home: string, target: string, mode: number) {
  const resolvedHome = await realpath(home);
  const parentPath = path.dirname(target);
  const name = path.basename(target);
  if (!name || name === "." || name === "..") {
    throw new Error("Path escapes the computer workspace");
  }

  const parentReal = await realpath(parentPath);
  if (!isAllowedDesktopPath(parentReal, [resolvedHome])) {
    throw new Error("Path escapes the computer workspace");
  }
  const parentBefore = await stat(parentReal);
  const parentHandle = await open(parentReal, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  const useWin32Relative = win32NtRelativeAvailable();

  let handle: ContainedHandle | undefined;
  let created = false;
  let openedPath = path.join(parentReal, name);
  try {
    // Bind the parent handle to a still-contained realpath. Otherwise a swap
    // after the first realpath can make inode checks agree on an outside dir
    // while pathname containment still sees the stale inside path.
    const containedParent = await assertContainedDirectoryHandle(
      parentHandle,
      parentReal,
      resolvedHome,
      parentBefore,
    );

    if (useWin32Relative) {
      // Open/create relative to the held parent HANDLE so a junction swap of the
      // parent pathname cannot redirect the write (true openat-style on Windows).
      try {
        handle = openExistingChildViaDirectoryFdWin32(parentHandle.fd, name);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
        handle = createExclusiveChildViaDirectoryFdWin32(parentHandle.fd, name);
        created = true;
        await handle.chmod(mode).catch(() => undefined);
      }
      try {
        openedPath = pathFromDirectoryFd(handle.fd);
      } catch {
        openedPath = path.join(containedParent, name);
      }
    } else {
      // Prefer directory-fd relative opens so a parent path swap cannot redirect creates.
      const viaDirFd = childPathViaDirFd(parentHandle.fd, name);
      openedPath = viaDirFd ?? path.join(containedParent, name);

      try {
        // Opening without O_TRUNC makes following a Windows reparse point non-destructive.
        handle = await open(openedPath, constants.O_WRONLY | O_NOFOLLOW);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
        handle = await open(
          openedPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
          mode,
        );
        created = true;
      }
    }

    const opened = await handle.stat({ bigint: true });
    // lstat the same child path we opened so a followed final symlink cannot match.
    const named = await lstat(openedPath, { bigint: true });
    if (
      !opened.isFile() ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      opened.nlink !== 1n ||
      named.nlink !== 1n
    ) {
      throw new Error("Path escapes the computer workspace");
    }
    await assertContainedFileHandle(handle, resolvedHome, parentHandle, containedParent, name);
    return handle;
  } catch (error) {
    if (created && handle) {
      const createdStat = await handle.stat({ bigint: true }).catch(() => undefined);
      let cleanupPath = openedPath;
      if (useWin32Relative) {
        try {
          cleanupPath = pathFromDirectoryFd(handle.fd);
        } catch {
          // Keep openedPath when GetFinalPathName is unavailable.
        }
      }
      await handle.close().catch(() => undefined);
      handle = undefined;
      // Only unlink if the path still names the inode we created.
      if (createdStat) {
        const present = await lstat(cleanupPath, { bigint: true }).catch(() => undefined);
        if (present && present.dev === createdStat.dev && present.ino === createdStat.ino) {
          await unlink(cleanupPath).catch(() => undefined);
        }
      }
    } else {
      await handle?.close().catch(() => undefined);
    }
    throw error;
  } finally {
    await parentHandle.close().catch(() => undefined);
  }
}

async function assertContainedDirectoryHandle(
  handle: ContainedHandle,
  pathToRecheck: string,
  resolvedHome: string,
  expected?: { dev: number; ino: number },
) {
  const after = await handle.stat();
  if (
    !after.isDirectory() ||
    (expected && (after.dev !== expected.dev || after.ino !== expected.ino))
  ) {
    throw new Error("Path escapes the computer workspace");
  }
  // Prefer fd-bound realpath so containment cannot diverge from the open handle.
  const resolved = await realpathFromFd(handle.fd);
  if (resolved) {
    const named = await lstat(resolved).catch(() => undefined);
    if (named?.isSymbolicLink() || !isAllowedDesktopPath(resolved, [resolvedHome])) {
      throw new Error("Path escapes the computer workspace");
    }
    const fully = await realpath(resolved);
    if (!isAllowedDesktopPath(fully, [resolvedHome])) {
      throw new Error("Path escapes the computer workspace");
    }
    return fully;
  }
  // Pathname platforms: re-open the realpath immediately and require the same inode.
  const byPath = await realpath(pathToRecheck);
  if (!isAllowedDesktopPath(byPath, [resolvedHome])) {
    throw new Error("Path escapes the computer workspace");
  }
  const verify = await open(byPath, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    const verified = await verify.stat();
    if (!verified.isDirectory() || verified.dev !== after.dev || verified.ino !== after.ino) {
      throw new Error("Path escapes the computer workspace");
    }
  } finally {
    await verify.close().catch(() => undefined);
  }
  return byPath;
}

async function assertContainedFileHandle(
  handle: ContainedHandle,
  resolvedHome: string,
  parentHandle: ContainedHandle,
  parentPath: string,
  childName: string,
) {
  const opened = await handle.stat({ bigint: true });
  if (!opened.isFile() || opened.nlink !== 1n) {
    throw new Error("Path escapes the computer workspace");
  }
  const resolved = await realpathFromFd(handle.fd);
  if (resolved) {
    const named = await lstat(resolved, { bigint: true });
    if (
      named.isSymbolicLink() ||
      !named.isFile() ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino ||
      named.nlink !== 1n ||
      !isAllowedDesktopPath(resolved, [resolvedHome])
    ) {
      throw new Error("Path escapes the computer workspace");
    }
    const fully = await realpath(resolved);
    if (!isAllowedDesktopPath(fully, [resolvedHome])) {
      throw new Error("Path escapes the computer workspace");
    }
    return;
  }
  // Pathname platforms: the parent path must still name the held parent inode,
  // and re-opening the child through that path must yield the same file. A
  // junction swap for open + restore before the parent check would otherwise
  // leave an outside handle while the parent path looks inside again.
  const parentOpened = await parentHandle.stat();
  const parentNow = await stat(parentPath);
  if (
    !parentNow.isDirectory() ||
    parentNow.dev !== parentOpened.dev ||
    parentNow.ino !== parentOpened.ino
  ) {
    throw new Error("Path escapes the computer workspace");
  }
  const parentReal = await realpath(parentPath);
  if (!isAllowedDesktopPath(parentReal, [resolvedHome])) {
    throw new Error("Path escapes the computer workspace");
  }
  const verifyPath = path.join(parentReal, childName);
  const verify = await open(verifyPath, constants.O_RDONLY | O_NOFOLLOW);
  try {
    const verified = await verify.stat({ bigint: true });
    const named = await lstat(verifyPath, { bigint: true });
    // Re-stat the write handle last so a hardlink planted during verify cannot
    // make an outside inode appear to live under the restored parent.
    const again = await handle.stat({ bigint: true });
    if (
      !verified.isFile() ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      verified.dev !== opened.dev ||
      verified.ino !== opened.ino ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino ||
      verified.nlink !== 1n ||
      named.nlink !== 1n ||
      again.dev !== opened.dev ||
      again.ino !== opened.ino ||
      again.nlink !== 1n
    ) {
      throw new Error("Path escapes the computer workspace");
    }
  } finally {
    await verify.close().catch(() => undefined);
  }
}

function childPathViaDirFd(fd: number, name: string) {
  if (process.platform === "linux") return `/proc/self/fd/${fd}/${name}`;
  return undefined;
}

async function realpathFromFd(fd: number) {
  if (process.platform === "linux") return realpath(`/proc/self/fd/${fd}`);
  if (process.platform === "win32") {
    try {
      return pathFromDirectoryFd(fd);
    } catch {
      // Hosts that only pretend to be win32 (unit tests) lack the Win32 APIs.
      return undefined;
    }
  }
  return undefined;
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function* walkDesktopWorkspace(
  home: string,
  directory: string,
  maxFileBytes?: number,
): AsyncIterable<PortableFile> {
  const target = await localWorkspaceTarget(home, directory, true);
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const relative = normalizeWorkspacePath(directory ? `${directory}/${entry.name}` : entry.name);
    const child = await localWorkspaceTarget(home, relative, true).catch(() => null);
    if (!child) continue;
    const info = await stat(child);
    if (shouldSkipPortableWorkspaceFile(relative, info.isDirectory())) continue;
    if (info.isDirectory()) {
      if (!(await isTaggedCacheDirectory(child)))
        yield* walkDesktopWorkspace(home, relative, maxFileBytes);
    } else if (info.isFile()) {
      if (maxFileBytes !== undefined && info.size > maxFileBytes)
        throw new Error(`computer file exceeds ${maxFileBytes} bytes`);
      yield {
        path: relative,
        content: new Uint8Array(await readFile(child)),
        executable: Boolean(info.mode & 0o100),
      };
    }
  }
}

function resolveExecuteCwd(requestCwd: string | undefined, home: string) {
  if (!requestCwd || requestCwd === "/home/rakazo" || requestCwd === "/home/user") return home;
  return path.resolve(home, requestCwd);
}

/** Batch files require cmd.exe and cannot be executed directly. */
const WINDOWS_SHELL_SCRIPT = /\.(?:bat|cmd)$/i;

/**
 * Argv for `spawn` with `shell: false`. Punctuation in paths and arguments is literal.
 */
function directCommandArgv(argv: readonly string[]): string[] | undefined {
  if (!Array.isArray(argv) || argv.length === 0) return undefined;
  if (argv.some((arg) => typeof arg !== "string" || arg.includes("\0"))) return undefined;
  const command = argv[0];
  if (!command || WINDOWS_SHELL_SCRIPT.test(command)) return undefined;
  return [...argv];
}

async function* streamLocalCommand(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  request: CommandRequest,
  own: (tree: NativeProcessTree) => void,
  sweep: () => void,
): AsyncIterable<ProcessEvent> {
  if (signal.aborted) {
    yield* abortedCommandEvents();
    return;
  }
  const direct = directCommandArgv(argv);
  if (!direct) {
    yield { type: "stderr", data: "command rejected\n" };
    yield { type: "exit", code: 1 };
    return;
  }
  const { child, tree } = spawnOwnedCommand(direct, cwd, hostCommandEnvironment(request));
  own(tree);
  const queue: ProcessEvent[] = [];
  let ended = false;
  let settled = false;
  let wake: (() => void) | undefined;
  const push = (event: ProcessEvent) => {
    queue.push(event);
    const notify = wake;
    wake = undefined;
    notify?.();
  };
  const finish = (code: number, stderrLine?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    if (stderrLine) push({ type: "stderr", data: appendLine("", stderrLine) });
    push({ type: "exit", code });
    ended = true;
    const notify = wake;
    wake = undefined;
    notify?.();
  };
  const terminate = (message: string, code: number) => {
    tree.kill();
    child.stdout?.destroy();
    child.stderr?.destroy();
    finish(code, message);
  };
  const abort = () => terminate("command aborted", 130);
  const timeout = setTimeout(
    () => terminate(`command timed out after ${timeoutMs} ms`, 124),
    timeoutMs,
  );
  timeout.unref?.();
  signal.addEventListener("abort", abort, { once: true });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (data: string) => {
    if (settled) return;
    push({ type: "stdout", data });
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (data: string) => {
    if (settled) return;
    push({ type: "stderr", data });
  });
  child.on("error", (error) => {
    if (settled) return;
    if (argv[0] === "echo") {
      push({ type: "stdout", data: `${argv.slice(1).join(" ")}\n` });
      finish(0);
    } else {
      push({ type: "stderr", data: error.message });
      finish(1);
    }
  });
  child.on("close", (code, exitSignal) => {
    finish(code ?? 1, exitSignal ? `command terminated by ${exitSignal}` : undefined);
  });
  if (signal.aborted) abort();
  try {
    while (!ended || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      const event = queue.shift();
      if (event) yield event;
    }
  } finally {
    if (!settled) {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      tree.kill();
      settled = true;
      ended = true;
    }
    sweep();
  }
}

function appendLine(existing: string, message: string) {
  return `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${message}\n`;
}
