import { mkdir, mkdtemp, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fileHandlePath } from "./file-handle-path.js";

it("resolves the held file after its original pathname is replaced", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-fd-path-"));
  try {
    const parent = path.join(root, "parent");
    const outside = path.join(root, "outside");
    await mkdir(parent);
    await mkdir(outside);
    await writeFile(path.join(parent, "file"), "original");
    await writeFile(path.join(outside, "file"), "replacement");
    const handle = await open(path.join(parent, "file"), "r");
    try {
      const canonical = await realpath(root);
      expect(await fileHandlePath(handle.fd)).toBe(path.join(canonical, "parent/file"));
      // Windows prevents moving a directory with an open child, but permits
      // moving the file itself. POSIX also exercises parent replacement here.
      const moved = process.platform === "win32" ? "parent/moved" : "moved/file";
      if (process.platform === "win32") {
        await rename(path.join(parent, "file"), path.join(root, moved));
        await symlink(path.join(outside, "file"), path.join(parent, "file"));
      } else {
        await rename(parent, path.join(root, "moved"));
        await symlink(outside, parent, "junction");
      }
      const expected = path.join(canonical, moved);
      expect(await fileHandlePath(handle.fd)).toBe(expected);
      expect(await handle.readFile("utf8")).toBe("original");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
