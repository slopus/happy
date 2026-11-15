import type * as NodeFs from "node:fs";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunExecutionHost } from "./run-execution.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  readFileSync: vi.fn(),
}));

const GiB = 1024 ** 3;

function cgroupFiles(inactiveFile: number) {
  vi.mocked(readFileSync).mockImplementation(((path: string) => {
    if (path === "/proc/self/cgroup") return "0::/\n";
    if (path === "/sys/fs/cgroup/memory.stat")
      return `anon 734003200\nfile ${inactiveFile + 4096}\ninactive_file ${inactiveFile}\nactive_file 4096\n`;
    throw new Error(`unexpected read ${path}`);
  }) as unknown as typeof readFileSync);
}

describe("RunExecutionHost memory admission", () => {
  let release: () => void;
  let released: Promise<void>;
  const execute = async ({ onRunStarted }: { onRunStarted: () => void }) => {
    onRunStarted();
    await released;
  };

  beforeEach(() => {
    released = new Promise((resolve) => {
      release = resolve;
    });
    vi.spyOn(process, "constrainedMemory").mockReturnValue(2 * GiB);
    vi.spyOn(process, "availableMemory").mockReturnValue(1024 ** 2);
  });
  afterEach(() => {
    release();
    vi.restoreAllMocks();
  });

  it("counts a container's inactive page cache as room for another run", async () => {
    cgroupFiles(GiB);
    const host = new RunExecutionHost();
    await host.execute(execute);
    await expect(host.execute(execute, { waitForCapacity: false })).resolves.toBe(true);
    release();
    await host.stop();
  });

  it("still holds runs back when the container's memory is really in use", async () => {
    cgroupFiles(0);
    const host = new RunExecutionHost();
    await host.execute(execute);
    await expect(host.execute(execute, { waitForCapacity: false })).resolves.toBe(false);
    release();
    await host.stop();
  });
});
