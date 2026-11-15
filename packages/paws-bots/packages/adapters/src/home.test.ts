import type * as FileSystem from "node:fs/promises";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentHomeStore } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { LocalAgentHomeStore, removeAgentHome } from "./home.js";

const hooks = vi.hoisted(() => ({
  afterRealpath: undefined as ((target: string) => Promise<void>) | undefined,
  beforeReaddir: undefined as ((target: string) => Promise<void>) | undefined,
  beforeOpen: undefined as ((target: string) => Promise<void>) | undefined,
  afterOpen: undefined as ((target: string) => Promise<void>) | undefined,
  beforeMkdir: undefined as ((target: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof FileSystem>();
  return {
    ...fs,
    realpath: async (...args: Parameters<typeof fs.realpath>) => {
      const result = await fs.realpath(...args);
      await hooks.afterRealpath?.(String(args[0]));
      return result;
    },
    readdir: async (...args: Parameters<typeof fs.readdir>) => {
      await hooks.beforeReaddir?.(String(args[0]));
      return fs.readdir(...args);
    },
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
      await hooks.beforeMkdir?.(String(args[0]));
      return fs.mkdir(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      await hooks.beforeOpen?.(String(args[0]));
      const handle = await fs.open(...args);
      await hooks.afterOpen?.(String(args[0]));
      return handle;
    },
  };
});

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};
const dirs: string[] = [];

afterEach(async () => {
  hooks.afterRealpath = undefined;
  hooks.beforeReaddir = undefined;
  hooks.beforeOpen = undefined;
  hooks.afterOpen = undefined;
  hooks.beforeMkdir = undefined;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-home-"));
  dirs.push(root);
  const store = new LocalAgentHomeStore(root);
  const home = store.pathFor("bot-1");
  await mkdir(home, { recursive: true });
  return { root, store, home };
}

async function exported(store: LocalAgentHomeStore, directory = "") {
  const files = [];
  for await (const file of store.exportHome("bot-1", context, { directory, skipHidden: true })) {
    files.push({ path: file.path, content: Buffer.from(file.content).toString("utf8") });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

describe("LocalAgentHomeStore path containment", () => {
  it.each([false, true])(
    "excludes caches from commits without descending into them (staged: %s)",
    async (staged) => {
      const { root, store } = await fixture();
      const staging = staged ? await store.createStaging() : undefined;
      const source = staging?.path ?? path.join(root, "source");
      try {
        for (const name of [
          "project/node_modules/pkg/index.js",
          ".cache/uv/data",
          ".yarn/cache/pkg",
          "packages/core/keep.txt",
          ".yarn/patches/fix.patch",
          "debug.log",
        ]) {
          await mkdir(path.dirname(path.join(source, name)), { recursive: true });
          await writeFile(path.join(source, name), "ok");
        }
        hooks.beforeReaddir = async (directory) => {
          if (directory.includes("node_modules") || directory.endsWith(".cache"))
            throw new Error("must prune before descending");
        };
        await store.commit("bot-1", source, context);
        expect(
          await readFile(path.join(store.pathFor("bot-1"), "packages/core/keep.txt"), "utf8"),
        ).toBe("ok");
        expect(
          await readFile(path.join(store.pathFor("bot-1"), ".yarn/patches/fix.patch"), "utf8"),
        ).toBe("ok");
        for (const name of ["project/node_modules", ".cache", ".yarn/cache", "debug.log"]) {
          await expect(stat(path.join(store.pathFor("bot-1"), name))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
        if (!staged) expect(await readFile(path.join(source, ".cache/uv/data"), "utf8")).toBe("ok");
      } finally {
        await staging?.remove();
      }
    },
  );

  it("keeps revision metadata external without reserving a workspace file name", async () => {
    const { root, store } = await fixture();
    const source = path.join(root, "checkpoint-source");
    await mkdir(source);
    await writeFile(path.join(source, "result.txt"), "durable");
    await writeFile(path.join(source, ".revision"), "belongs to the user");

    const revision = await store.commit("bot-1", source, context);
    const exported = [];
    for await (const file of store.exportHome("bot-1", context)) exported.push(file.path);

    expect(revision).toMatch(/^rev-/);
    expect(store.describe().capabilities.revisions).toBe(false);
    expect(exported.sort()).toEqual([".revision", "result.txt"]);
  });

  it("rejects lexical traversal and sibling-prefix paths", async () => {
    const { store } = await fixture();
    await expect(store.readFile("bot-1", "../../homes-other/secret", context)).rejects.toThrow(
      /escapes|invalid/i,
    );
  });

  it("rejects oversized reads before loading their contents", async () => {
    const { store, home } = await fixture();
    await writeFile(path.join(home, "large.txt"), "12345");

    await expect(store.readFile("bot-1", "large.txt", context, { maxBytes: 4 })).rejects.toThrow(
      /exceeds 4 bytes/,
    );
  });

  it("allows symlinks whose resolved target stays inside the bot home", async () => {
    const { store, home } = await fixture();
    await writeFile(path.join(home, "target.txt"), "before");
    await symlink("target.txt", path.join(home, "link.txt"));

    expect(await store.readFile("bot-1", "link.txt", context)).toBe("before");
    await store.writeFile("bot-1", "link.txt", "after", context);
    expect(await readFile(path.join(home, "target.txt"), "utf8")).toBe("after");
  });

  it("rejects an opened file reached through a swapped parent even after the parent is restored", async () => {
    const { root, store, home } = await fixture();
    const directory = path.join(await realpath(home), "notes");
    const parked = path.join(await realpath(home), "parked-notes");
    const outside = path.join(await realpath(root), "outside");
    const target = path.join(directory, "result.txt");
    await mkdir(directory);
    await mkdir(outside);
    await writeFile(target, "inside");
    await writeFile(path.join(outside, "result.txt"), "outside");
    hooks.beforeOpen = async (file) => {
      if (file !== target) return;
      hooks.beforeOpen = undefined;
      await rename(directory, parked);
      await symlink(outside, directory, "junction");
    };
    hooks.afterOpen = async (file) => {
      if (file !== target) return;
      hooks.afterOpen = undefined;
      await rm(directory);
      await rename(parked, directory);
    };

    await expect(store.readFile("bot-1", "notes/result.txt", context)).rejects.toThrow(/escapes/i);
    expect(await store.readFile("bot-1", "notes/result.txt", context)).toBe("inside");
  });

  it("allows directory symlinks that remain inside the bot home", async () => {
    const { store, home } = await fixture();
    await mkdir(path.join(home, "target-dir"));
    await symlink(path.join(home, "target-dir"), path.join(home, "linked-dir"), "junction");

    await store.writeFile("bot-1", "linked-dir/result.txt", "safe", context);
    expect(await readFile(path.join(home, "target-dir", "result.txt"), "utf8")).toBe("safe");
    expect(await store.list("bot-1", "linked-dir", context)).toEqual([
      { path: "linked-dir/result.txt", kind: "file", size: 4 },
    ]);
  });

  it("rejects reads and writes through symlinks outside the bot home", async () => {
    const { root, store, home } = await fixture();
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "secret");
    await symlink(outside, path.join(home, "escape.txt"));

    await expect(store.readFile("bot-1", "escape.txt", context)).rejects.toThrow(/escapes/i);
    await expect(store.writeFile("bot-1", "escape.txt", "changed", context)).rejects.toThrow(
      /escapes/i,
    );
    expect(await readFile(outside, "utf8")).toBe("secret");
  });

  it("does not create directories through an external symlink", async () => {
    const { root, store, home } = await fixture();
    const outside = path.join(root, "outside-dir");
    await mkdir(outside);
    await symlink(outside, path.join(home, "escape-dir"), "junction");

    await expect(
      store.writeFile("bot-1", "escape-dir/new/result.txt", "changed", context),
    ).rejects.toThrow(/escapes/i);
    await expect(readFile(path.join(outside, "new", "result.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("hides external symlinks from listings and exports", async () => {
    const { root, store, home } = await fixture();
    await writeFile(path.join(home, "safe.txt"), "safe");
    await symlink(path.join(root, "outside"), path.join(home, "external"));
    await writeFile(path.join(root, "outside"), "secret");

    expect(await store.list("bot-1", "", context)).toEqual([
      { path: "safe.txt", kind: "file", size: 4 },
    ]);
    const exported = [];
    for await (const file of store.exportHome("bot-1", context)) exported.push(file.path);
    expect(exported).toEqual(["safe.txt"]);
  });

  it("exports a directory with containment checked against the directory itself", async () => {
    const { store, home } = await fixture();
    await mkdir(path.join(home, "bots/bot-a/notes"), { recursive: true });
    await mkdir(path.join(home, "bots/bot-b"), { recursive: true });
    await writeFile(path.join(home, "bots/bot-a/notes/result.txt"), "mine");
    await writeFile(path.join(home, "bots/bot-b/secret.txt"), "other");
    await symlink("../bot-b", path.join(home, "bots/bot-a/peer-dir"), "junction");
    await symlink("../bot-b/secret.txt", path.join(home, "bots/bot-a/peer-file"));
    await symlink("bot-b", path.join(home, "bots/bot-c"), "junction");
    await symlink("notes/result.txt", path.join(home, "bots/bot-a/latest.txt"));
    const exported = async (directory: string) => {
      const files = [];
      for await (const file of store.exportHome("bot-1", context, { directory }))
        files.push(file.path);
      return files;
    };

    expect((await exported("bots/bot-a")).sort()).toEqual(["latest.txt", "notes/result.txt"]);
    expect(await exported("bots/bot-c")).toEqual([]);
    expect(await exported("bots/missing")).toEqual([]);
    await expect(exported("../outside")).rejects.toThrow(/escapes/i);
  });

  it("skips hidden top-level entries, also behind visible links", async () => {
    const { store, home } = await fixture();
    await mkdir(path.join(home, ".config"), { recursive: true });
    await mkdir(path.join(home, "project"), { recursive: true });
    await writeFile(path.join(home, ".bash_history"), "history");
    await writeFile(path.join(home, ".config/token"), "token");
    await writeFile(path.join(home, "project/.gitignore"), "dist");
    await symlink(".bash_history", path.join(home, "history.txt"));
    await symlink(".config/token", path.join(home, "token.txt"));
    await symlink(".config", path.join(home, "config"), "junction");
    await symlink(".gitignore", path.join(home, "project/ignore.txt"));

    const files = [];
    for await (const file of store.exportHome("bot-1", context, { skipHidden: true })) {
      files.push(file.path);
    }
    expect(files.sort()).toEqual(["project/.gitignore", "project/ignore.txt"]);
  });

  it("skips hidden top-level links to visible entries without hiding their targets", async () => {
    const { store, home } = await fixture();
    await mkdir(path.join(home, "settings"), { recursive: true });
    await writeFile(path.join(home, "settings/theme.txt"), "dark");
    await symlink("settings", path.join(home, ".config"), "junction");
    await symlink("settings/theme.txt", path.join(home, ".theme"));

    const files = [];
    for await (const file of store.exportHome("bot-1", context, { skipHidden: true })) {
      files.push(file.path);
    }
    expect(files).toEqual(["settings/theme.txt"]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails an export whose directory cannot be read instead of returning nothing",
    async () => {
      const { store, home } = await fixture();
      await mkdir(path.join(home, "bots/bot-a"), { recursive: true });
      await chmod(path.join(home, "bots"), 0o000);
      try {
        const files = store.exportHome("bot-1", context, { directory: "bots/bot-a" });
        await expect(files[Symbol.asyncIterator]().next()).rejects.toMatchObject({
          code: "EACCES",
        });
      } finally {
        await chmod(path.join(home, "bots"), 0o755);
      }
    },
  );

  it.each(["peer", "shared", "home", "outside"])(
    "rejects a workspace root or parent linked to %s",
    async (targetKind) => {
      for (const component of ["bots/bot-a", "bots"]) {
        const { root, store, home } = await fixture();
        const target = {
          peer: path.join(home, "peer"),
          shared: path.join(home, "shared"),
          home,
          outside: path.join(root, "outside"),
        }[targetKind]!;
        await mkdir(path.join(target, "bot-a"), { recursive: true });
        await writeFile(path.join(target, "secret.txt"), "secret");
        await writeFile(path.join(target, "bot-a/secret.txt"), "secret");
        await mkdir(path.dirname(path.join(home, component)), { recursive: true });
        await symlink(target, path.join(home, component), "junction");
        expect(await exported(store, "bots/bot-a")).toEqual([]);
      }
    },
  );

  it.each(["", "bots/bot-a"])("rejects a linked home or homes parent for %s", async (directory) => {
    for (const component of ["home", "homes"]) {
      for (const targetKind of ["peer", "shared", "home", "outside"]) {
        const { root, store, home } = await fixture();
        const target = {
          peer:
            component === "home" ? path.join(root, "homes/bot-2") : path.join(root, "peer-homes"),
          shared: path.join(root, "shared"),
          home: root,
          outside: path.join(root, "outside"),
        }[targetKind]!;
        const linked = component === "home" ? home : path.dirname(home);
        const targetHome = component === "home" ? target : path.join(target, "bot-1");
        await mkdir(path.join(targetHome, "bots/bot-a"), { recursive: true });
        await writeFile(path.join(targetHome, "secret.txt"), "secret");
        await writeFile(path.join(targetHome, "bots/bot-a/secret.txt"), "secret");
        await rm(linked, { recursive: true });
        await symlink(target, linked, "junction");
        expect(await exported(store, directory)).toEqual([]);
      }
    }
  });

  it.each(["", "bots/bot-a"])("exports nothing for a missing root (%s)", async (directory) => {
    const { store, home } = await fixture();
    expect(await exported(store, directory)).toEqual([]);
    await rm(home, { recursive: true });
    expect(await exported(store, directory)).toEqual([]);
  });

  it("exports nothing for dangling and looping workspace roots and parents", async () => {
    for (const component of ["bots/bot-a", "bots"]) {
      for (const target of ["missing", path.basename(component)]) {
        const { store, home } = await fixture();
        await mkdir(path.dirname(path.join(home, component)), { recursive: true });
        await symlink(target, path.join(home, component));
        expect(await exported(store, "bots/bot-a")).toEqual([]);
      }
    }
  });

  it.each(["", "bots/bot-a"])("rejects a looping home for %s", async (directory) => {
    const { store, home } = await fixture();
    await rm(home, { recursive: true });
    await symlink("bot-1", home);
    expect(await exported(store, directory)).toEqual([]);
  });

  it.each(["", "bots/bot-a"])("does not rewalk root aliases for %s", async (directory) => {
    const { store, home } = await fixture();
    const root = path.join(home, directory);
    await mkdir(path.join(root, ".config"), { recursive: true });
    await writeFile(path.join(root, ".config/token"), "secret");
    await writeFile(path.join(root, ".bash_history"), "secret");
    await writeFile(path.join(root, "mine.txt"), "mine");
    await writeFile(path.join(path.dirname(root), "sibling.txt"), "secret");
    await symlink(".", path.join(root, "a-self"), "junction");
    await symlink("..", path.join(root, "b-parent"), "junction");
    await symlink(home, path.join(root, "c-home"), "junction");
    expect(await exported(store, directory)).toEqual([{ path: "mine.txt", content: "mine" }]);
  });

  it.each(["a-link", "z-link"])("visits visible directory aliases once (%s)", async (link) => {
    const { store, home } = await fixture();
    await mkdir(path.join(home, "middle"));
    await writeFile(path.join(home, "middle/.gitignore"), "dist");
    await symlink("middle", path.join(home, link), "junction");
    await symlink("middle", path.join(home, ".hidden"), "junction");
    const files = await exported(store);
    expect(files).toHaveLength(1);
    expect(["middle/.gitignore", `${link}/.gitignore`]).toContain(files[0]!.path);
    expect(files[0]!.content).toBe("dist");
  });

  it.each(["", "bots/bot-a"])(
    "pins the root during traversal and open for %s",
    async (directory) => {
      for (const phase of ["afterRealpath", "beforeReaddir", "beforeOpen"] as const) {
        for (const component of ["root", "parent"] as const) {
          const { root: data, store, home } = await fixture();
          const root = path.join(home, directory);
          await mkdir(root, { recursive: true });
          await writeFile(path.join(root, "result.txt"), "mine");
          const canonical = await realpath(root);
          const swapped = component === "root" ? canonical : path.dirname(canonical);
          const relative = path.relative(swapped, canonical);
          const outside = path.join(data, "outside");
          await mkdir(path.join(outside, relative), { recursive: true });
          await writeFile(path.join(outside, relative, "result.txt"), "secret");
          let didSwap = false;
          let resolutions = 0;
          hooks[phase] = async (target) => {
            if (
              target !== (phase === "beforeOpen" ? path.join(canonical, "result.txt") : canonical)
            )
              return;
            // Private exports resolve the home before capturing the export root.
            if (phase === "afterRealpath" && directory === "" && ++resolutions < 2) return;
            hooks[phase] = undefined;
            didSwap = true;
            await rename(swapped, `${swapped}.saved`);
            await symlink(outside, swapped, "junction");
          };
          if (phase === "beforeOpen") {
            hooks.afterOpen = async () => {
              hooks.afterOpen = undefined;
              await rm(swapped);
              await rename(`${swapped}.saved`, swapped);
            };
            await expect(exported(store, directory)).rejects.toThrow(/escapes/i);
          } else {
            expect(await exported(store, directory)).toEqual([]);
          }
          expect(didSwap).toBe(true);
        }
      }
    },
  );

  it("propagates directory read and descendant resolution errors", async () => {
    const { store, home } = await fixture();
    await writeFile(path.join(home, "result.txt"), "mine");
    const error = Object.assign(new Error("Access denied"), { code: "EACCES" });
    hooks.beforeReaddir = async () => {
      throw error;
    };
    await expect(exported(store)).rejects.toBe(error);
    hooks.beforeReaddir = undefined;
    hooks.afterRealpath = async (target) => {
      if (target.endsWith("result.txt")) throw error;
    };
    await expect(exported(store)).rejects.toBe(error);
  });

  it("lists a folder another request creates at the same moment", async () => {
    const { store, home } = await fixture();
    hooks.beforeMkdir = async (target) => {
      if (target === path.join(await realpath(home), "shared")) {
        hooks.beforeMkdir = undefined;
        await mkdir(target);
      }
    };

    expect(await store.list("bot-1", "shared", context)).toEqual([]);
  });

  it("still refuses a dangling link where a folder would be made", async () => {
    const { root, store, home } = await fixture();
    await symlink(path.join(root, "outside"), path.join(home, "shared"));

    await expect(store.list("bot-1", "shared", context)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(path.join(root, "outside"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips hidden names before resolving their targets", async () => {
    const { store, home } = await fixture();
    await writeFile(path.join(home, "mine.txt"), "mine");
    await symlink("mine.txt", path.join(home, ".hidden"));
    hooks.afterRealpath = async (target) => {
      if (target.endsWith(".hidden")) throw new Error("Hidden target must not be resolved");
    };
    expect(await exported(store)).toEqual([{ path: "mine.txt", content: "mine" }]);
  });

  it("rejects an opened file moved into a hidden top entry", async () => {
    const { store, home } = await fixture();
    await mkdir(path.join(home, ".config"));
    await writeFile(path.join(home, "result.txt"), "secret");
    hooks.afterOpen = async () => {
      hooks.afterOpen = undefined;
      await rename(path.join(home, "result.txt"), path.join(home, ".config/token"));
    };
    await expect(exported(store)).rejects.toThrow(/hidden/i);
  });

  it("exports and copies internal links, bytes, empty directories, and file modes", async () => {
    const { root, store, home } = await fixture();
    const bytes = Buffer.from([0, 255, 127, 10]);
    await mkdir(path.join(home, "nested/empty"), { recursive: true });
    await writeFile(path.join(home, "nested/run"), bytes);
    await chmod(path.join(home, "nested/run"), 0o750);
    await symlink("nested/run", path.join(home, "linked"));
    await symlink(home, path.join(home, "nested/loop"), "junction");

    const files = [];
    for await (const file of store.exportHome("bot-1", context)) files.push(file);
    expect(files.map((file) => file.path).sort()).toEqual(["linked", "nested/run"]);
    for (const file of files) {
      expect(Buffer.from(file.content)).toEqual(bytes);
      if (process.platform !== "win32") expect(file.executable).toBe(true);
    }
    const dest = path.join(root, "checkout");
    await store.checkout("bot-1", dest, context);
    expect(await readFile(path.join(dest, "linked"))).toEqual(bytes);
    expect((await stat(path.join(dest, "nested/empty"))).isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(path.join(dest, "nested/run"))).mode & 0o777).toBe(0o750);
    }
    await store.commit("bot-2", dest, context);
    expect(await readFile(path.join(store.pathFor("bot-2"), "nested/run"))).toEqual(bytes);
  });
});

describe("LocalAgentHomeStore with Go's read-only module cache", () => {
  /** Go makes module directories 0555 and their files 0444, and the link must not be followed. */
  async function seedModuleCache(dir: string, outside: string) {
    const module = path.join(dir, "go/pkg/mod/example.com/m@v1.0.0");
    await mkdir(module, { recursive: true });
    await writeFile(path.join(module, "go.mod"), "module example.com/m\n");
    await symlink(outside, path.join(module, "outside"));
    await chmod(path.join(module, "go.mod"), 0o444);
    await chmod(module, 0o555);
    await chmod(path.dirname(module), 0o555);
  }

  it.each([
    [
      "deleting the computer",
      ["bot-1", "bot-1.previous"],
      (store: LocalAgentHomeStore) => store.remove("bot-1"),
    ],
    [
      "deleting it through another store",
      ["bot-1"],
      (_store: LocalAgentHomeStore, root: string) =>
        removeAgentHome({} as AgentHomeStore, "bot-1", root),
    ],
    [
      "removing a Team bot's folder",
      ["bot-1/bots/gone"],
      (store: LocalAgentHomeStore) => store.removeFolders("bot-1", "bots", ["gone"]),
    ],
  ])("removes the cache when %s", async (_case, seeded, removeIt) => {
    const { root, store } = await fixture();
    const outside = path.join(root, "outside");
    // Empty, so cleanup can still remove it.
    await mkdir(outside, { mode: 0o555 });
    for (const dir of seeded) await seedModuleCache(path.join(root, "homes", dir), outside);

    await removeIt(store, root);

    for (const dir of seeded) await expect(stat(path.join(root, "homes", dir))).rejects.toThrow();
    expect((await stat(outside)).mode & 0o777).toBe(0o555);
  });

  // Root removes read-only directories without making them writable first.
  it.skipIf(process.getuid?.() === 0)("only makes directories writable that are not", async () => {
    const { root, store, home } = await fixture();
    await seedModuleCache(home, root);
    const probe = await open(home, "r");
    const chmodHandle = vi.spyOn(Object.getPrototypeOf(probe), "chmod");
    await probe.close();
    onTestFinished(() => chmodHandle.mockRestore());

    await store.remove("bot-1");

    await expect(stat(home)).rejects.toThrow();
    // Only example.com and the module, not the writable home, go, pkg and mod above them.
    expect(chmodHandle).toHaveBeenCalledTimes(2);
  });

  // Root removes read-only directories without making them writable first.
  it.skipIf(process.getuid?.() === 0)(
    "stops at a directory swapped for a link while it makes the tree writable",
    async () => {
      const { root, store, home } = await fixture();
      const module = path.join(home, "go/pkg/mod");
      await mkdir(module, { recursive: true });
      await writeFile(path.join(module, "go.mod"), "module example.com/m\n");
      await chmod(module, 0o555);
      const outside = path.join(root, "outside");
      // Empty, so cleanup can still remove it.
      await mkdir(outside);
      await mkdir(path.join(outside, "pkg"), { mode: 0o555 });
      hooks.beforeOpen = async (target) => {
        if (target !== path.join(home, "go/pkg")) return;
        hooks.beforeOpen = undefined;
        await rename(path.join(home, "go"), path.join(home, "go-moved"));
        await symlink(outside, path.join(home, "go"));
      };

      try {
        await expect(store.remove("bot-1")).rejects.toThrow(/escapes/);
        expect((await stat(path.join(outside, "pkg"))).mode & 0o777).toBe(0o555);
      } finally {
        await chmod(path.join(home, "go-moved/pkg/mod"), 0o755);
      }
    },
  );

  it("replaces a home that holds the module cache", async () => {
    const { root, store, home } = await fixture();
    // An interrupted save's previous copy, and the home the save moves aside.
    await seedModuleCache(`${home}.previous`, root);
    await seedModuleCache(home, root);
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(source, "new.txt"), "new");

    await store.commit("bot-1", source, context);

    await expect(readFile(path.join(home, "new.txt"), "utf8")).resolves.toBe("new");
    await expect(stat(`${home}.previous`)).rejects.toThrow();
  });
});
