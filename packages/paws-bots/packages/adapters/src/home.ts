import { randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile as readTextFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { AdapterContext, AgentHomeStore, PortableFile } from "@rakazo/adapter-kit";
import { fileHandlePath } from "./file-handle-path.js";
import {
  isTaggedCacheDirectory,
  shouldSkipPortableWorkspaceFile,
} from "./workspace-save-policy.js";

const STAGING_PREFIX = "rakazo-workspace-";
/** Staging directories in use are touched this often, so other processes can tell them apart. */
const STAGING_HEARTBEAT_MS = 30_000;
/** A staging directory untouched this long belongs to a process that died. */
export const STALE_STAGING_MS = 5 * 60_000;

export class LocalAgentHomeStore implements AgentHomeStore {
  private readonly botWrites = new Map<string, Promise<void>>();

  constructor(protected readonly root: string) {}

  describe() {
    return {
      id: "local-fs",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { revisions: false },
    };
  }

  private botDir(botId: string) {
    if (!botId || botId === "." || botId === ".." || path.basename(botId) !== botId) {
      throw new Error("Invalid bot id");
    }
    return path.join(this.root, "homes", botId);
  }

  pathFor(botId: string) {
    return path.resolve(this.botDir(botId));
  }

  async checkout(botId: string, dest: string, _context: AdapterContext): Promise<string> {
    await this.waitForBotWrite(botId);
    await this.recoverInterruptedCommit(botId);
    await mkdir(dest, { recursive: true });
    const src = this.botDir(botId);
    await mkdir(src, { recursive: true });
    await copyDir(src, dest);
    return "working";
  }

  async commit(botId: string, src: string, _context: AdapterContext): Promise<string> {
    // Files staged on this volume by `createStaging` are moved into place, not copied, so a
    // save never needs room for two copies.
    const staged = path.dirname(path.resolve(src)) === path.resolve(this.root, "staging");
    return this.withBotWrite(botId, async () => {
      await this.replaceHome(botId, async (staging) => {
        if (!staged) return copyDir(src, staging);
        await removeExcludedStagedEntries(src);
        await rm(staging, { recursive: true, force: true });
        await rename(src, staging);
      });
      return this.writeRevision(botId);
    });
  }

  /**
   * Fills a staging directory beside the home, then swaps it in. An interruption leaves the
   * previous copy, which the next access restores. Callers hold the bot's write lock.
   */
  protected async replaceHome(botId: string, fill: (staging: string) => Promise<void>) {
    await this.recoverInterruptedCommit(botId);
    const dest = this.botDir(botId);
    const parent = path.dirname(dest);
    const staging = path.join(parent, `.${botId}.staging-${randomUUID()}`);
    const previous = `${dest}.previous`;
    await mkdir(parent, { recursive: true });
    await mkdir(staging, { recursive: true });
    const stopHeartbeat = keepFresh(staging);
    try {
      await fill(staging);
      await removeTree(previous);
      if (await pathExists(dest)) await rename(dest, previous);
      try {
        await rename(staging, dest);
      } catch (error) {
        if (!(await pathExists(dest)) && (await pathExists(previous))) {
          await rename(previous, dest).catch(() => undefined);
        }
        throw error;
      }
      await removeTree(previous);
    } finally {
      stopHeartbeat();
      await rm(staging, { recursive: true, force: true });
    }
  }

  /**
   * A new directory on the data volume for a computer's files on their way into the store.
   * It is touched while in use; call `remove` when done.
   */
  async createStaging(): Promise<StagingDirectory> {
    return createStagingDirectory(path.join(this.root, "staging"));
  }

  /**
   * Removes staging directories a killed process left behind: on the data volume once nothing
   * has touched them for a while (another process may still be using them), and in the
   * system temp directory, which older releases used, once they also predate this process.
   */
  async removeStaleStaging(now = Date.now()): Promise<number> {
    const stale = now - STALE_STAGING_MS;
    const [staged, homes, temporary] = await Promise.all([
      staleEntries(path.join(this.root, "staging"), isStagingName, stale),
      staleEntries(
        path.join(this.root, "homes"),
        (name) => name.startsWith(".") && name.includes(".staging-"),
        stale,
      ),
      staleEntries(tmpdir(), isStagingName, Math.min(stale, performance.timeOrigin)),
    ]);
    const doomed = [...staged, ...homes, ...temporary];
    await Promise.all(doomed.map((entry) => rm(entry, { recursive: true, force: true })));
    return doomed.length;
  }

  async revise(botId: string): Promise<string> {
    return this.withBotWrite(botId, async () => this.writeRevision(botId));
  }

  async restore(
    botId: string,
    _revision: string,
    dest: string,
    context: AdapterContext,
  ): Promise<void> {
    await this.checkout(botId, dest, context);
  }

  async *exportHome(
    botId: string,
    _context: AdapterContext,
    { directory = "", skipHidden = false }: { directory?: string; skipHidden?: boolean } = {},
  ): AsyncIterable<PortableFile> {
    await this.waitForBotWrite(botId);
    await this.recoverInterruptedCommit(botId);
    const dir = this.botDir(botId);
    // Resolve the configured store first so a linked home cannot redefine containment.
    const storeRoot = await resolveExportPath(this.root);
    if (!storeRoot) return;
    const home = await resolveExportPath(dir);
    if (home !== safeJoin(storeRoot, `homes/${botId}`)) return;
    const expected = safeJoin(home, directory);
    const root = await resolveExportPath(expected);
    if (root !== expected) return;
    yield* walkFiles(root, root, skipHidden);
  }

  async readFile(
    botId: string,
    filePath: string,
    _context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<string> {
    await this.waitForBotWrite(botId);
    await this.recoverInterruptedCommit(botId);
    const { root, full } = await containedExistingPath(this.botDir(botId), filePath);
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      assertContained(root, await fileHandlePath(handle.fd));
      if (options?.maxBytes !== undefined) {
        const info = await handle.stat();
        if (info.size > options.maxBytes) {
          throw new Error(`agent home file exceeds ${options.maxBytes} bytes`);
        }
      }
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }

  async writeFile(
    botId: string,
    filePath: string,
    content: string,
    _context: AdapterContext,
  ): Promise<void> {
    await this.withBotWrite(botId, async () => {
      await this.recoverInterruptedCommit(botId);
      const full = await containedWritePath(this.botDir(botId), filePath);
      const handle = await open(
        full,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o666,
      );
      try {
        await handle.writeFile(content, "utf8");
      } finally {
        await handle.close();
      }
    });
  }

  async list(botId: string, dirPath: string, _context: AdapterContext) {
    await this.waitForBotWrite(botId);
    await this.recoverInterruptedCommit(botId);
    const root = this.botDir(botId);
    const candidate = safeJoin(root, dirPath);
    const full = await ensureContainedDirectory(root, candidate);
    const entries = await readdir(full, { withFileTypes: true });
    const listed = await Promise.all(
      entries.map(async (entry) => {
        const child = await containedTarget(root, path.join(full, entry.name)).catch(() => null);
        if (!child) return null;
        const info = await stat(child);
        return {
          path: path.posix.join(dirPath.replace(/\\/g, "/"), entry.name),
          kind: info.isDirectory() ? ("dir" as const) : ("file" as const),
          size: info.size,
        };
      }),
    );
    return listed.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }

  /**
   * Deletes folders directly under `parent` (a Team Computer's bot folders or browser profiles)
   * and returns whether any were there. Only for a home no running computer mounts: a symlinked
   * parent is refused and a final symlink is unlinked.
   */
  async removeFolders(botId: string, parent: string, names: readonly string[]): Promise<boolean> {
    return this.withBotWrite(botId, async () => {
      await this.recoverInterruptedCommit(botId);
      let removed = false;
      for (const name of names) {
        if (await removeContainedDirectory(this.botDir(botId), parent, name)) removed = true;
      }
      return removed;
    });
  }

  /** Deletes this host's copy of a home, an interrupted save's previous copy and its revision. */
  async remove(botId: string): Promise<void> {
    await this.withBotWrite(botId, () => this.removeCopy(botId));
  }

  /** `remove` for callers that already hold the bot's write lock. */
  protected async removeCopy(botId: string) {
    const dir = this.botDir(botId);
    // The previous copy first, or a read in between would restore it as the home.
    await removeTree(`${dir}.previous`);
    await removeTree(dir);
    await rm(this.revisionFile(botId), { force: true });
    await rm(this.downloadedFile(botId), { force: true });
  }

  /**
   * Records that this host's copy came from object storage. A file beside the revision marker,
   * rather than a change to its contents, so a previous release reading the marker keeps working.
   */
  protected async markDownloaded(botId: string) {
    await mkdir(path.join(this.root, "home-downloads"), { recursive: true });
    await writeFile(this.downloadedFile(botId), "");
  }

  protected async isDownloaded(botId: string): Promise<boolean> {
    return stat(this.downloadedFile(botId)).then(
      () => true,
      () => false,
    );
  }

  protected async touchRevision(botId: string) {
    const now = new Date();
    await utimes(this.revisionFile(botId), now, now).catch(() => undefined);
  }

  /** When the local copy was last saved, downloaded or used, if it has a revision. */
  protected async revisionUsedAt(botId: string): Promise<number | undefined> {
    return stat(this.revisionFile(botId)).then(
      (info) => info.mtimeMs,
      () => undefined,
    );
  }

  protected async writeRevision(botId: string, revision = newRevision()) {
    const directory = path.join(this.root, "home-revisions");
    await mkdir(directory, { recursive: true });
    const file = this.revisionFile(botId);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, revision, "utf8");
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
    return revision;
  }

  protected async localRevision(botId: string): Promise<string | undefined> {
    return readTextFile(this.revisionFile(botId), "utf8").catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
  }

  private downloadedFile(botId: string) {
    return path.join(this.root, "home-downloads", path.basename(this.botDir(botId)));
  }

  private revisionFile(botId: string) {
    return path.join(this.root, "home-revisions", `${path.basename(this.botDir(botId))}.txt`);
  }

  protected async recoverInterruptedCommit(botId: string) {
    const dest = this.botDir(botId);
    const previous = `${dest}.previous`;
    if (!(await pathExists(dest)) && (await pathExists(previous))) await rename(previous, dest);
  }

  protected async withBotWrite<T>(botId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.botWrites.get(botId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Keep the chain alive even when a prior write rejects, so later writers are not stuck
    // behind a permanently rejected predecessor.
    const queued = previous.catch(() => undefined).then(() => current);
    this.botWrites.set(botId, queued);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.botWrites.get(botId) === queued) this.botWrites.delete(botId);
    }
  }

  private async waitForBotWrite(botId: string) {
    await (this.botWrites.get(botId) ?? Promise.resolve());
  }
}

export function resolveAgentHomePath(home: AgentHomeStore, homeKey: string, dataDir = "./data") {
  if (home instanceof LocalAgentHomeStore) return home.pathFor(homeKey);
  return path.resolve(dataDir, "homes", homeKey);
}

/** Deletes the home of a deleted computer from this host. */
export async function removeAgentHome(home: AgentHomeStore, homeKey: string, dataDir = "./data") {
  if (home instanceof LocalAgentHomeStore) return home.remove(homeKey);
  await removeTree(resolveAgentHomePath(home, homeKey, dataDir));
}

/**
 * Deletes folders under `parent` in a stored home and saves the result, so a computer that boots
 * from it later, on any host, no longer has them.
 */
export async function removeAgentHomeFolders(
  home: AgentHomeStore,
  homeKey: string,
  parent: string,
  names: readonly string[],
  dataDir = "./data",
): Promise<void> {
  if (home instanceof LocalAgentHomeStore) {
    await home.removeFolders(homeKey, parent, names);
    return;
  }
  for (const name of names)
    await removeContainedDirectory(resolveAgentHomePath(home, homeKey, dataDir), parent, name);
}

export function newRevision() {
  return `rev-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function safeJoin(root: string, rel: string) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, `.${path.sep}${rel.replace(/^\/+/, "")}`);
  assertContained(resolvedRoot, resolved);
  return resolved;
}

async function containedExistingPath(root: string, rel: string) {
  await mkdir(root, { recursive: true });
  const resolvedRoot = await realpath(root);
  const full = await realpath(safeJoin(resolvedRoot, rel));
  assertContained(resolvedRoot, full);
  return { root: resolvedRoot, full };
}

async function containedWritePath(root: string, rel: string) {
  await mkdir(root, { recursive: true });
  const candidate = safeJoin(root, rel);
  const resolvedParent = await ensureContainedDirectory(root, path.dirname(candidate));
  try {
    return await containedTarget(root, path.join(resolvedParent, path.basename(candidate)));
  } catch (error) {
    if (isMissing(error)) return path.join(resolvedParent, path.basename(candidate));
    throw error;
  }
}

async function ensureContainedDirectory(root: string, candidate: string) {
  await mkdir(root, { recursive: true });
  const lexicalRoot = path.resolve(root);
  const lexicalCandidate = path.resolve(candidate);
  assertContained(lexicalRoot, lexicalCandidate);
  const resolvedRoot = await realpath(root);
  const relative = path.relative(lexicalRoot, lexicalCandidate);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    const next = path.join(current, segment);
    try {
      current = await realpath(next);
    } catch (error) {
      if (!isMissing(error)) throw error;
      // A concurrent request can make the folder first; a dangling link still fails realpath.
      await mkdir(next).catch((failure: unknown) => {
        if (!(failure instanceof Error && "code" in failure && failure.code === "EEXIST")) {
          throw failure;
        }
      });
      current = await realpath(next);
    }
    assertContained(resolvedRoot, current);
    if (!(await stat(current)).isDirectory()) throw new Error("Path component is not a directory");
  }
  return current;
}

async function containedTarget(root: string, candidate: string) {
  const [resolvedRoot, resolvedTarget] = await Promise.all([realpath(root), realpath(candidate)]);
  assertContained(resolvedRoot, resolvedTarget);
  return resolvedTarget;
}

export function isContained(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function assertContained(root: string, candidate: string) {
  if (!isContained(root, candidate)) throw new Error("Path escapes the bot home");
}

function isHiddenTopEntry(root: string, candidate: string) {
  return path.relative(root, candidate).split(path.sep)[0]!.startsWith(".");
}

/** Delete one folder in a home. A symlinked parent is refused; a final symlink is unlinked. */
async function removeContainedDirectory(root: string, parent: string, name: string) {
  const target = path.join(root, parent, name);
  const info = await lstat(target).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (!info) return false;
  const parentInfo = await lstat(path.dirname(target)).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (!parentInfo || parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error("folder escapes the team home");
  }
  if (info.isSymbolicLink()) {
    await unlink(target);
    return true;
  }
  const resolvedRoot = await realpath(root);
  const resolvedTarget = await realpath(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (
    path.dirname(resolvedTarget) !== path.join(resolvedRoot, parent) ||
    path.basename(resolvedTarget) !== name ||
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error("folder escapes the team home");
  }
  await removeTree(resolvedTarget);
  return true;
}

/**
 * Deletes a directory tree, including read-only directories its owner can change, such as Go's
 * module cache: those without owner write get full owner access. Only directories whose opened
 * handle is still inside the tree are changed; a parent swapped for a link during the walk stops it.
 */
async function removeTree(target: string) {
  try {
    await rm(target, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    await makeWritable(target);
    await rm(target, { recursive: true, force: true });
  }
}

async function makeWritable(directory: string, root?: string) {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let tree = root;
  try {
    const opened = await fileHandlePath(handle.fd);
    tree ??= opened;
    assertContained(tree, opened);
    const { mode } = await handle.stat();
    if (!(mode & 0o200)) await handle.chmod((mode & 0o7777) | 0o700);
  } finally {
    await handle.close();
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeWritable(path.join(directory, entry.name), tree);
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function pathExists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function resolveExportPath(candidate: string) {
  return realpath(candidate).catch((error: unknown) => {
    if (isMissing(error) || (error as NodeJS.ErrnoException).code === "ELOOP") return null;
    throw error;
  });
}

async function exportTarget(root: string, candidate: string, skipHidden: boolean) {
  const resolved = await resolveExportPath(candidate);
  if (!resolved || !isContained(root, resolved)) return null;
  if (skipHidden && isHiddenTopEntry(root, resolved)) return null;
  return resolved;
}

async function traversalTarget(root: string, candidate: string) {
  const resolved = await realpath(candidate);
  assertContained(root, resolved);
  return resolved;
}

async function readTraversalFile(root: string, full: string, skipHidden = false) {
  const handle = await open(
    full,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Home entry is not a regular file");
    // O_NOFOLLOW only protects the final component. A parent can be swapped
    // during open and restored before any pathname recheck. Check the actual
    // opened object against the root captured once for the entire traversal.
    const opened = await fileHandlePath(handle.fd);
    assertContained(root, opened);
    if (skipHidden && isHiddenTopEntry(root, opened)) throw new Error("Home entry is hidden");
    return { content: await handle.readFile(), mode: info.mode };
  } finally {
    await handle.close();
  }
}

/** Copies one file in bounded chunks, with the same containment checks as reading it. */
async function copyTraversalFile(root: string, full: string, to: string) {
  const handle = await open(
    full,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Home entry is not a regular file");
    assertContained(root, await fileHandlePath(handle.fd));
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      createWriteStream(to, { mode: info.mode & 0o777 }),
    );
  } finally {
    await handle.close();
  }
}

export interface StagingDirectory {
  path: string;
  remove(): Promise<void>;
}

/** A private directory under `parent` that stays fresh until removed. */
export async function createStagingDirectory(parent = tmpdir()): Promise<StagingDirectory> {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(parent, STAGING_PREFIX));
  const stopHeartbeat = keepFresh(directory);
  return {
    path: directory,
    async remove() {
      stopHeartbeat();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function keepFresh(directory: string) {
  const timer = setInterval(() => {
    const now = new Date();
    utimes(directory, now, now).catch(() => undefined);
  }, STAGING_HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

function isStagingName(name: string) {
  return name.startsWith(STAGING_PREFIX);
}

async function staleEntries(parent: string, matches: (name: string) => boolean, before: number) {
  const names = await readdir(parent).catch(() => [] as string[]);
  const found = await Promise.all(
    names.filter(matches).map(async (name) => {
      const entry = path.join(parent, name);
      const info = await lstat(entry).catch(() => undefined);
      return info?.isDirectory() && info.mtimeMs < before ? entry : undefined;
    }),
  );
  return found.filter((entry): entry is string => entry !== undefined);
}

async function copyDir(
  src: string,
  dest: string,
  sourceRoot?: string,
  visited = new Set<string>(),
) {
  const root = sourceRoot ?? (await realpath(src));
  const current = await traversalTarget(root, src).catch(() => null);
  if (!current || visited.has(current)) return;
  await mkdir(dest, { recursive: true });
  visited.add(current);
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const from = await traversalTarget(root, path.join(current, entry.name)).catch(() => null);
    if (!from) continue;
    const to = path.join(dest, entry.name);
    const info = await stat(from);
    if (
      shouldSkipPortableWorkspaceFile(
        path.relative(root, path.join(current, entry.name)).split(path.sep).join("/"),
        info.isDirectory(),
      ) ||
      (info.isDirectory() && (await isTaggedCacheDirectory(from)))
    )
      continue;
    if (info.isDirectory()) await copyDir(from, to, root, visited);
    else if (info.isFile()) await copyTraversalFile(root, from, to);
  }
}

async function* walkFiles(
  root: string,
  current: string,
  skipHidden: boolean,
  outputPath = "",
  visited = new Set<string>(),
): AsyncGenerator<PortableFile> {
  const resolvedCurrent = await exportTarget(root, current, skipHidden);
  if (!resolvedCurrent || visited.has(resolvedCurrent)) return;
  visited.add(resolvedCurrent);
  const entries = await readdir(resolvedCurrent, { withFileTypes: true });
  for (const entry of entries) {
    const portablePath = path.posix.join(outputPath, entry.name);
    if (skipHidden && portablePath.startsWith(".")) continue;
    const full = await exportTarget(root, path.join(resolvedCurrent, entry.name), skipHidden);
    if (!full) continue;
    const info = await stat(full);
    if (shouldSkipPortableWorkspaceFile(portablePath, info.isDirectory())) continue;
    if (info.isDirectory()) {
      if (await isTaggedCacheDirectory(full)) continue;
      yield* walkFiles(root, full, skipHidden, portablePath, visited);
    } else if (info.isFile()) {
      const { content, mode } = await readTraversalFile(root, full, skipHidden);
      yield { path: portablePath, content, executable: Boolean(mode & 0o100) };
    }
  }
}

/** Only private save staging is pruned; mounted homes are never cleaned by a save. */
async function removeExcludedStagedEntries(root: string, directory = root) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    const relative = path.relative(root, full).split(path.sep).join("/");
    if (
      shouldSkipPortableWorkspaceFile(relative, entry.isDirectory()) ||
      (entry.isDirectory() && (await isTaggedCacheDirectory(full)))
    ) {
      await rm(full, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      await removeExcludedStagedEntries(root, full);
    }
  }
}
