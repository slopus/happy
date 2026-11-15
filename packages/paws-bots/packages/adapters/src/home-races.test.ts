import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as FileHandlePathModule from "./file-handle-path.js";
import { fileHandlePath } from "./file-handle-path.js";
import { LocalAgentHomeStore } from "./home.js";

vi.mock("./file-handle-path.js", async (importOriginal) => {
  const actual = await importOriginal<typeof FileHandlePathModule>();
  return { fileHandlePath: vi.fn(actual.fileHandlePath) };
});

const race = vi.hoisted(() => ({
  afterStat: undefined as (() => Promise<void>) | undefined,
  beforeOpen: undefined as (() => Promise<void>) | undefined,
  afterOpen: undefined as (() => Promise<void>) | undefined,
  target: "",
  opened: [] as fs.FileHandle[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof fs.stat>) => {
      const info = await actual.stat(...args);
      if (args[0] === race.target && race.afterStat) {
        const replace = race.afterStat;
        race.afterStat = undefined;
        await replace();
      }
      return info;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === race.target) await race.beforeOpen?.();
      const handle = await actual.open(...args);
      if (args[0] === race.target) {
        race.opened.push(handle);
        vi.spyOn(handle, "readFile");
        await race.afterOpen?.();
      }
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
  race.afterStat = undefined;
  race.beforeOpen = undefined;
  race.afterOpen = undefined;
  race.opened = [];
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe.each(["export", "checkout", "commit"] as const)(
  "home %s source containment",
  (operation) => {
    it.each(["file", "parent", "root", "parent restored after open"] as const)(
      "rejects a %s replaced after validation",
      async (replacement) => {
        const root = await fs.mkdtemp(path.join(tmpdir(), "rakazo-home-race-"));
        dirs.push(root);
        const store = new LocalAgentHomeStore(root);
        const source = operation === "commit" ? path.join(root, "source") : store.pathFor("bot-1");
        const parent = path.join(source, "nested");
        const target = path.join(parent, "result.txt");
        const outside = path.join(root, "outside");
        const dest = path.join(root, "checkout");
        await fs.mkdir(parent, { recursive: true });
        await fs.mkdir(outside);
        await fs.writeFile(target, "safe content");
        await fs.writeFile(path.join(outside, "result.txt"), "fake outside secret");
        await fs.mkdir(path.join(outside, "nested"));
        await fs.writeFile(path.join(outside, "nested/result.txt"), "fake outside secret");
        race.target = await fs.realpath(target);
        let replaced = false;
        const replace = async () => {
          if (replacement === "file") {
            await fs.rm(target);
            await fs.symlink(path.join(outside, "result.txt"), target);
          } else if (replacement === "root") {
            await fs.rename(source, `${source}-original`);
            await fs.symlink(outside, source, "junction");
          } else {
            await fs.rename(parent, `${parent}-original`);
            await fs.symlink(outside, parent, "junction");
          }
          replaced = true;
        };
        if (replacement === "parent restored after open") {
          race.beforeOpen = replace;
          race.afterOpen = async () => {
            await fs.rm(parent);
            await fs.rename(`${parent}-original`, parent);
          };
        } else race.afterStat = replace;

        const run = async () => {
          if (operation === "checkout") {
            await store.checkout("bot-1", dest, context);
            return fs.readFile(path.join(dest, "nested/result.txt"), "utf8");
          }
          if (operation === "commit") {
            await store.commit("bot-1", source, context);
            return fs.readFile(path.join(store.pathFor("bot-1"), "nested/result.txt"), "utf8");
          }
          const contents = [];
          for await (const file of store.exportHome("bot-1", context)) {
            contents.push(Buffer.from(file.content).toString());
          }
          return contents;
        };
        await expect(run()).rejects.toThrow(/escapes|ELOOP/);
        expect(replaced).toBe(true);
        for (const handle of race.opened) {
          expect(handle.readFile).not.toHaveBeenCalled();
          expect(handle.fd).toBe(-1);
        }
        if (operation !== "export") {
          const output = operation === "checkout" ? dest : store.pathFor("bot-1");
          await expect(fs.readFile(path.join(output, "nested/result.txt"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      },
    );
  },
);

it("reads the held safe file when its pathname changes after open", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "rakazo-home-race-"));
  dirs.push(root);
  const store = new LocalAgentHomeStore(root);
  const home = store.pathFor("bot-1");
  await fs.mkdir(home, { recursive: true });
  const target = path.join(home, "result.txt");
  const outside = path.join(root, "outside.txt");
  await fs.writeFile(target, "safe content");
  await fs.writeFile(outside, "fake outside secret");
  race.target = await fs.realpath(target);
  race.afterOpen = async () => {
    await fs.rename(target, path.join(home, "moved.txt"));
    await fs.symlink(outside, target);
  };
  const files = [];
  for await (const file of store.exportHome("bot-1", context)) files.push(file);
  expect(files).toHaveLength(1);
  expect(Buffer.from(files[0]!.content).toString()).toBe("safe content");
  expect(race.opened[0]!.fd).toBe(-1);
});

it("fails before reading when descriptor containment cannot be established", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "rakazo-home-race-"));
  dirs.push(root);
  const store = new LocalAgentHomeStore(root);
  const home = store.pathFor("bot-1");
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, "result.txt"), "safe content");
  race.target = await fs.realpath(path.join(home, "result.txt"));
  vi.mocked(fileHandlePath).mockRejectedValueOnce(new Error("Descriptor lookup unavailable"));

  await expect(store.exportHome("bot-1", context)[Symbol.asyncIterator]().next()).rejects.toThrow(
    "Descriptor lookup unavailable",
  );
  expect(race.opened).toHaveLength(1);
  expect(race.opened[0]!.readFile).not.toHaveBeenCalled();
  expect(race.opened[0]!.fd).toBe(-1);
});

it.runIf(process.platform === "win32")(
  "rejects a descriptor on another Windows volume",
  async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "rakazo-home-race-"));
    dirs.push(root);
    const store = new LocalAgentHomeStore(root);
    const home = store.pathFor("bot-1");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "result.txt"), "safe content");
    race.target = await fs.realpath(path.join(home, "result.txt"));
    const drive = path.parse(race.target).root.toLowerCase() === "z:\\" ? "y:" : "z:";
    vi.mocked(fileHandlePath).mockResolvedValueOnce(`${drive}\\outside\\result.txt`);
    await expect(store.exportHome("bot-1", context)[Symbol.asyncIterator]().next()).rejects.toThrow(
      /escapes/,
    );
    expect(race.opened[0]!.readFile).not.toHaveBeenCalled();
    expect(race.opened[0]!.fd).toBe(-1);
  },
);
