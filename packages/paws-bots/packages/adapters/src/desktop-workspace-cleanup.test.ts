import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeOwnedWorkspaceChildren } from "./desktop-workspace-cleanup.js";

const signal = new AbortController().signal;
describe("native workspace directory cleanup", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "rakazo-cleanup-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("refuses a parent swapped to an outside link after validation", async () => {
    const parent = path.join(root, "bots");
    const outside = path.join(root, "outside");
    await mkdir(parent);
    await mkdir(path.join(outside, "deleted-bot"), { recursive: true });
    const marker = path.join(outside, "deleted-bot", "keep.txt");
    await writeFile(marker, "keep");
    const identity = await lstat(parent, { bigint: true });
    await rename(parent, path.join(root, "original-bots"));
    await symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");
    await expect(
      removeOwnedWorkspaceChildren(parent, ["deleted-bot"], identity, signal),
    ).rejects.toThrow();
    expect(await readFile(marker, "utf8")).toBe("keep");
  });

  it("removes nested workspace contents without following directory links", async () => {
    const parent = path.join(root, "bots");
    const outside = path.join(root, "outside");
    await mkdir(path.join(parent, "deleted-bot", "nested"), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(outside, "keep.txt"), "keep");
    await writeFile(path.join(parent, "deleted-bot", "nested", "file.txt"), "remove");
    await symlink(
      outside,
      path.join(parent, "deleted-bot", "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await removeOwnedWorkspaceChildren(
      parent,
      ["deleted-bot"],
      await lstat(parent, { bigint: true }),
      signal,
    );
    await expect(lstat(path.join(parent, "deleted-bot"))).rejects.toThrow();
    expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
  });

  it("removes a folder that holds Go's read-only module cache", async () => {
    const parent = path.join(root, "bots");
    const module = path.join(parent, "deleted-bot", "go", "pkg", "mod", "example.com", "m@v1.0.0");
    await mkdir(module, { recursive: true });
    await writeFile(path.join(module, "go.mod"), "module example.com/m\n");
    await chmod(path.join(module, "go.mod"), 0o444);
    await chmod(module, 0o555);
    await chmod(path.dirname(module), 0o555);
    await removeOwnedWorkspaceChildren(
      parent,
      ["deleted-bot"],
      await lstat(parent, { bigint: true }),
      signal,
    );
    await expect(lstat(path.join(parent, "deleted-bot"))).rejects.toThrow();
  });
});
