import type * as NodeFs from "node:fs";
import type * as NodeFsPromises from "node:fs/promises";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const lstatRace = vi.hoisted(() => ({
  after: undefined as undefined | ((target: string) => Promise<void>),
  afterRealpath: undefined as undefined | ((target: string) => Promise<void>),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    constants: { ...actual.constants, O_NOFOLLOW: 0 },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  return {
    ...actual,
    lstat: async (target: string, options?: { bigint?: boolean }) => {
      const result = await actual.lstat(target, options as never);
      await lstatRace.after?.(target);
      return result;
    },
    realpath: async (target: string) => {
      const result = await actual.realpath(target);
      await lstatRace.afterRealpath?.(target);
      return result;
    },
  };
});

const { DesktopSandboxProvider } = await import("./desktop-sandbox.js");

const ctx = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};
const roots: string[] = [];

afterEach(async () => {
  lstatRace.after = undefined;
  lstatRace.afterRealpath = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(botId: string) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-desktop-containment-")));
  roots.push(root);
  const desktop = new DesktopSandboxProvider({ root });
  const computer = await desktop.provision({ botId, homePath: "/unused" }, ctx);
  return { root, desktop, computer };
}

async function pathExists(target: string) {
  try {
    await realpath(target);
    return true;
  } catch {
    return false;
  }
}

describe("desktop sandbox write containment without O_NOFOLLOW", () => {
  it("rejects an existing final symlink without changing its outside target", async () => {
    const { root, desktop, computer } = await fixture("static-link");
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "before");
    await symlink(outside, path.join(computer.providerRef, "escape.txt"));

    await expect(
      desktop.writeFile(computer, {
        path: "escape.txt",
        content: new TextEncoder().encode("after"),
      }),
    ).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("before");
  });

  it("keeps writes contained when the final name is replaced after lstat", async () => {
    const { root, desktop, computer } = await fixture("swap-link");
    const target = path.join(computer.providerRef, "result.txt");
    const displaced = path.join(computer.providerRef, "result-original.txt");
    const outside = path.join(root, "outside.txt");
    await writeFile(target, "inside-before");
    await writeFile(outside, "outside-before");
    let swapped = false;
    lstatRace.after = async (inspected) => {
      if (swapped || path.basename(inspected) !== "result.txt") return;
      swapped = true;
      await rename(target, displaced);
      await symlink(outside, target);
    };

    let rejected = false;
    try {
      await desktop.writeFile(computer, {
        path: "result.txt",
        content: new TextEncoder().encode("after"),
      });
    } catch (error) {
      expect(error).toHaveProperty("message", "Path escapes the computer workspace");
      rejected = true;
    }
    expect(swapped).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("outside-before");
    expect(await readFile(displaced, "utf8")).toBe(rejected ? "inside-before" : "after");
  });

  it("rejects a parent symlink that resolves outside the workspace", async () => {
    const { root, desktop, computer } = await fixture("parent-link");
    const outside = path.join(root, "outside-directory");
    await mkdir(outside);
    await symlink(outside, path.join(computer.providerRef, "escape-directory"), "junction");

    await expect(
      desktop.writeFile(computer, {
        path: "escape-directory/outside.txt",
        content: new TextEncoder().encode("after"),
      }),
    ).rejects.toThrow();
    await expect(readFile(path.join(outside, "outside.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not create outside directories through a parent symlink", async () => {
    const { root, desktop, computer } = await fixture("parent-link-nested");
    const outside = path.join(root, "outside-directory");
    await mkdir(outside);
    await symlink(outside, path.join(computer.providerRef, "escape-directory"), "junction");

    await expect(
      desktop.writeFile(computer, {
        path: "escape-directory/nested/outside.txt",
        content: new TextEncoder().encode("after"),
      }),
    ).rejects.toThrow();
    await expect(readFile(path.join(outside, "nested/outside.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(path.join(outside, "nested"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not write outside when a validated parent is replaced before open", async () => {
    const { root, desktop, computer } = await fixture("parent-swap");
    const parent = path.join(computer.providerRef, "notes");
    const displaced = path.join(computer.providerRef, "notes-original");
    const outside = path.join(root, "outside-directory");
    await mkdir(parent);
    await mkdir(outside);
    await writeFile(path.join(parent, "result.txt"), "inside-before");
    await writeFile(path.join(outside, "result.txt"), "outside-before");
    let swapped = false;
    lstatRace.afterRealpath = async (inspected) => {
      if (swapped || path.basename(inspected) !== "notes") return;
      swapped = true;
      await rename(parent, displaced);
      await symlink(outside, parent, "junction");
    };

    await expect(
      desktop.writeFile(computer, {
        path: "notes/result.txt",
        content: new TextEncoder().encode("after"),
      }),
    ).rejects.toThrow();
    expect(swapped).toBe(true);
    expect(await readFile(path.join(outside, "result.txt"), "utf8")).toBe("outside-before");
    expect(await readFile(path.join(displaced, "result.txt"), "utf8")).toBe("inside-before");
  });

  it("does not leave an outside file when exclusive create races through a swapped parent", async () => {
    const { root, desktop, computer } = await fixture("parent-swap-create");
    const parent = path.join(computer.providerRef, "notes");
    const displaced = path.join(computer.providerRef, "notes-original");
    const outside = path.join(root, "outside-directory");
    await mkdir(parent);
    await mkdir(outside);
    let swapped = false;
    lstatRace.afterRealpath = async (inspected) => {
      if (swapped || path.basename(inspected) !== "notes") return;
      swapped = true;
      await rename(parent, displaced);
      await symlink(outside, parent, "junction");
    };

    await expect(
      desktop.writeFile(computer, {
        path: "notes/result.txt",
        content: new TextEncoder().encode("after"),
      }),
    ).rejects.toThrow();
    expect(swapped).toBe(true);
    await expect(readFile(path.join(outside, "result.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not create outside directories when a parent is swapped during mkdir", async () => {
    const { root, desktop, computer } = await fixture("mkdir-swap");
    const parent = path.join(computer.providerRef, "notes");
    const displaced = path.join(computer.providerRef, "notes-original");
    const outside = path.join(root, "outside-directory");
    await mkdir(parent);
    await mkdir(outside);
    let swapped = false;
    lstatRace.afterRealpath = async (inspected) => {
      if (swapped || path.basename(inspected) !== "notes") return;
      swapped = true;
      await rename(parent, displaced);
      await symlink(outside, parent, "junction");
    };

    await expect(
      desktop.writeFile(computer, {
        path: "notes/nested/result.txt",
        content: new TextEncoder().encode("after"),
      }),
    ).rejects.toThrow();
    expect(swapped).toBe(true);
    await expect(readFile(path.join(outside, "nested/result.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(path.join(outside, "nested"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects when path containment and the opened inode diverge after a parent swap", async () => {
    const { root, desktop, computer } = await fixture("inode-diverge");
    const parent = path.join(computer.providerRef, "notes");
    const displaced = path.join(computer.providerRef, "notes-original");
    const outside = path.join(root, "outside-directory");
    await mkdir(parent);
    await mkdir(outside);
    await writeFile(path.join(parent, "result.txt"), "inside-before");
    await writeFile(path.join(outside, "result.txt"), "outside-before");

    // Force pathname opens so containment must bind directory/file inodes (Windows path).
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      let notesRealpaths = 0;
      lstatRace.afterRealpath = async (inspected) => {
        if (path.basename(inspected) !== "notes") return;
        notesRealpaths += 1;
        // After openContainedWorkspaceFile's parent realpath, point the pathname at an
        // outside directory. Without binding the opened parent inode to a fresh
        // contained realpath, later checks could validate a restored inside path
        // while the handle still referred outside.
        if (notesRealpaths !== 2) return;
        await rename(parent, displaced);
        await symlink(outside, parent, "junction");
      };
      lstatRace.after = async (inspected) => {
        if (path.basename(inspected) !== "result.txt") return;
        // If a child open happened, restore an inside pathname so realpath-only
        // containment would incorrectly pass without an inode bind.
        if (!(await pathExists(parent))) return;
        await rm(parent, { force: true });
        if (await pathExists(displaced)) await rename(displaced, parent);
      };

      await expect(
        desktop.writeFile(computer, {
          path: "notes/result.txt",
          content: new TextEncoder().encode("after"),
        }),
      ).rejects.toThrow();
      expect(notesRealpaths).toBeGreaterThanOrEqual(2);
      expect(await readFile(path.join(outside, "result.txt"), "utf8")).toBe("outside-before");
      // Inside content lives under the displaced original parent after the race.
      expect(await readFile(path.join(displaced, "result.txt"), "utf8")).toBe("inside-before");
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
      else Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    }
  });

  it("rejects a hard link whose other name is outside the workspace", async () => {
    const { root, desktop, computer } = await fixture("hard-link");
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "outside-before");
    await link(outside, path.join(computer.providerRef, "escape.txt"));

    await expect(
      desktop.writeFile(computer, {
        path: "escape.txt",
        content: new TextEncoder().encode("after"),
      }),
    ).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("outside-before");
  });

  it("still creates and replaces ordinary workspace files", async () => {
    const { desktop, computer } = await fixture("ordinary-files");

    await desktop.writeFile(computer, {
      path: "notes/result.txt",
      content: new TextEncoder().encode("first"),
    });
    await desktop.writeFile(computer, {
      path: "notes/result.txt",
      content: new TextEncoder().encode("second"),
    });

    expect(await readFile(path.join(computer.providerRef, "notes/result.txt"), "utf8")).toBe(
      "second",
    );
  });
});
