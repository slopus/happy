import type { Stats } from "node:fs";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, opendir, readlink } from "node:fs/promises";
import path from "node:path";

const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/**
 * Windows reports every entry as owner 0 with mode 0o666 and keeps NTFS ACLs out of `fs.Stats`,
 * so the POSIX mode walk can only produce a false refusal there (a directory then lacks the
 * execute bit). The structural checks in the walk still run on Windows.
 */
const hasPosixPermissions = process.platform !== "win32";

function hasPermissions(stat: Stats, uid: number, gid: number, required: number): boolean {
  const shift = stat.uid === uid ? 6 : stat.gid === gid ? 3 : 0;
  return ((stat.mode >> shift) & required) === required;
}

/**
 * Owner-owned regular files may be 0444 (git objects) when the owner can read them.
 * Other-writable files are not exempt.
 */
function regularFileIsUsable(stat: Stats, uid: number, gid: number): boolean {
  if (hasPermissions(stat, uid, gid, 0b010)) return true;
  return (
    stat.isFile() &&
    stat.uid === uid &&
    hasPermissions(stat, uid, gid, 0b100) &&
    (stat.mode & constants.S_IWOTH) === 0
  );
}

/** Go makes module-cache directories read-only unless -modcacherw is set. */
function directoryIsUsable(stat: Stats, uid: number, gid: number, entry: string): boolean {
  if (hasPermissions(stat, uid, gid, 0b111)) return true;
  // Match the walked path, never a symlink target, and keep the exception owner-only.
  return (
    stat.uid === uid &&
    (entry === "go/pkg/mod" || entry.startsWith("go/pkg/mod/")) &&
    (stat.mode & 0o022) === 0 &&
    hasPermissions(stat, uid, gid, 0b101)
  );
}

function isMissingOrNotDirectory(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR";
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

async function resolveFdPath(fd: number): Promise<string> {
  return readlink(`/proc/self/fd/${fd}`);
}

async function assertFdBeneathRoot(handle: FileHandle, rootPath: string): Promise<void> {
  const currentPath = await resolveFdPath(handle.fd);
  if (!isPathInside(rootPath, currentPath)) {
    throw new Error(`computer home check escaped validated root ${rootPath}; saw ${currentPath}`);
  }
}

/** Keeps the error far below the 8 KiB the API reads; past that it drops the whole message. */
const MAX_ENTRY_CHARACTERS = 120;

/**
 * chown cannot fix an entry the uid already owns, while chmod -R u+rwX gives every owned folder the
 * rwx the rule asks for. Entry names come from the bot, so the command comes first and names only
 * the configured root, and the entry is shortened and quoted last.
 */
function writabilityError(
  entry: string,
  root: string,
  uid: number,
  gid: number,
  owner: number,
): Error {
  const fix =
    owner === uid
      ? `sudo chmod -R u+rwX ${JSON.stringify(root)}`
      : `sudo chown -R ${uid}:${gid} ${JSON.stringify(root)} or use Compose data-init`;
  const characters = [...(entry || ".")];
  const shown =
    characters.length > MAX_ENTRY_CHARACTERS
      ? `…${characters.slice(1 - MAX_ENTRY_CHARACTERS).join("")}`
      : characters.join("");
  return new Error(
    `computer home is not usable by uid ${uid}; run ${fix} (entry ${JSON.stringify(shown)})`,
  );
}

/**
 * The fd walk opens a folder before checking its mode. A refused folder is reported only when its
 * mode shuts out the uid too; any other refusal (another supervisor uid, SELinux, NFS root squash)
 * is rethrown as is.
 */
async function refusedFolderError(
  error: unknown,
  statPath: string,
  entry: string,
  root: string,
  uid: number,
  gid: number,
): Promise<unknown> {
  if ((error as NodeJS.ErrnoException).code !== "EACCES") return error;
  const stat = await lstat(statPath).catch(() => undefined);
  if (!stat?.isDirectory() || directoryIsUsable(stat, uid, gid, entry)) return error;
  return writabilityError(entry, root, uid, gid, stat.uid);
}

/** Pathname walk for non-Linux hosts without /proc/self/fd containment. */
async function assertWritableEntry(
  target: string,
  entry: string,
  root: string,
  uid: number,
  gid: number,
): Promise<void> {
  const isRoot = entry === "";
  let stat: Stats;
  try {
    stat = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !isRoot) return;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`computer home ${root} does not exist`);
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    if (isRoot) throw new Error(`computer home ${root} must not be a symbolic link`);
    return;
  }
  if (isRoot && !stat.isDirectory()) {
    throw new Error(`computer home ${root} must be a directory`);
  }

  const usable =
    !hasPosixPermissions ||
    (stat.isDirectory()
      ? directoryIsUsable(stat, uid, gid, entry)
      : regularFileIsUsable(stat, uid, gid));
  if (!usable) {
    throw writabilityError(entry, root, uid, gid, stat.uid);
  }
  if (!stat.isDirectory()) return;

  const directory = await opendir(target);
  for await (const child of directory) {
    const childEntry = path.posix.join(entry, child.name);
    await assertWritableEntry(path.join(target, child.name), childEntry, root, uid, gid);
  }
}

async function assertWritableDirectory(
  handle: FileHandle,
  rootPath: string,
  entry: string,
  root: string,
  uid: number,
  gid: number,
): Promise<void> {
  await assertFdBeneathRoot(handle, rootPath);
  const stat = await handle.stat();
  if (!directoryIsUsable(stat, uid, gid, entry)) {
    throw writabilityError(entry, root, uid, gid, stat.uid);
  }

  const descriptorPath = `/proc/self/fd/${handle.fd}`;
  const directory = await opendir(descriptorPath);
  for await (const child of directory) {
    const childPath = path.join(descriptorPath, child.name);
    const childEntry = path.posix.join(entry, child.name);
    let childDir: FileHandle | undefined;
    try {
      childDir = await open(childPath, DIRECTORY_OPEN_FLAGS);
    } catch (error) {
      if (!isMissingOrNotDirectory(error)) {
        throw await refusedFolderError(error, childPath, childEntry, root, uid, gid);
      }
    }
    if (childDir) {
      try {
        await assertFdBeneathRoot(childDir, rootPath);
        await assertWritableDirectory(childDir, rootPath, childEntry, root, uid, gid);
      } finally {
        await childDir.close();
      }
      continue;
    }

    let childStat: Stats;
    try {
      childStat = await lstat(childPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (childStat.isSymbolicLink()) continue;
    if (childStat.isDirectory()) {
      throw new Error(`computer home ${root} changed during validation; retry the request`);
    }
    if (!regularFileIsUsable(childStat, uid, gid)) {
      throw writabilityError(childEntry, root, uid, gid, childStat.uid);
    }
  }

  await assertFdBeneathRoot(handle, rootPath);
}

async function assertWritableLinux(root: string, uid: number, gid: number): Promise<void> {
  let rootStat: Stats;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`computer home ${root} does not exist`);
    }
    throw error;
  }
  if (rootStat.isSymbolicLink()) {
    throw new Error(`computer home ${root} must not be a symbolic link`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`computer home ${root} must be a directory`);
  }

  let handle: FileHandle;
  try {
    handle = await open(root, DIRECTORY_OPEN_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`computer home ${root} does not exist`);
    if (code === "ELOOP") throw new Error(`computer home ${root} must not be a symbolic link`);
    if (code === "ENOTDIR") throw new Error(`computer home ${root} must be a directory`);
    throw await refusedFolderError(error, root, "", root, uid, gid);
  }
  try {
    const rootPath = await resolveFdPath(handle.fd);
    await assertWritableDirectory(handle, rootPath, "", root, uid, gid);
  } finally {
    await handle.close();
  }
}

/** Validate without privileged mutation before a computer receives the home bind mount. */
export async function assertComputerHomeWritable(
  root: string,
  uid: number,
  gid: number,
): Promise<void> {
  if (process.platform === "linux") {
    await assertWritableLinux(root, uid, gid);
    return;
  }
  await assertWritableEntry(root, "", root, uid, gid);
}

/** Exported for regression coverage of the moved-directory escape check. */
export async function assertOpenedDirectoryBeneathRoot(
  handle: FileHandle,
  rootPath: string,
): Promise<void> {
  await assertFdBeneathRoot(handle, rootPath);
}
