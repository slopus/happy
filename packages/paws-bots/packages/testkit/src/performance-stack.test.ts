import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { benchmarkEnvironment, safeName, stopProcess } from "./cli/performance-stack.js";

describe("benchmarkEnvironment", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("disables inherited billing configuration without changing the parent environment", () => {
    const billing = {
      STRIPE_SECRET_KEY: "sk_test_benchmark_placeholder",
      STRIPE_WEBHOOK_SECRET: "whsec_benchmark_placeholder",
      STRIPE_PRICE_ID: "price_benchmark_placeholder",
    };
    for (const [name, value] of Object.entries(billing)) vi.stubEnv(name, value);
    const env = benchmarkEnvironment({
      databaseUrl: "postgres://benchmark:benchmark@127.0.0.1:5432/benchmark",
      webPort: 5173,
      apiPort: 3000,
      dataDir: "/tmp/benchmark-data",
    });
    expect(env).toMatchObject({
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      STRIPE_PRICE_ID: "",
      AGENT_RUNTIME: "scripted",
      SIGNUPS_ENABLED: "true",
    });
    expect(process.env).toMatchObject(billing);
  });
});

describe("stopProcess", () => {
  it("returns for a child that exited normally", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(child, "exit");
    expect(child.exitCode).toBe(0);
    await stopProcess(child);
  });

  it("returns for a child that was already terminated by a signal", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await once(child, "spawn");
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBe("SIGTERM");
    await stopProcess(child);
  }, 4_000);

  it("allows concurrent and repeated cleanup of a running child", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await once(child, "spawn");
    const setTimer = vi.spyOn(globalThis, "setTimeout");
    const clearTimer = vi.spyOn(globalThis, "clearTimeout");
    try {
      await Promise.all([stopProcess(child), stopProcess(child)]);
      expect(child.signalCode).toBe("SIGTERM");
      expect(child.listenerCount("exit")).toBe(0);
      const timeoutIndices = setTimer.mock.calls.flatMap((args, index) =>
        args[1] === 5_000 ? [index] : [],
      );
      expect(timeoutIndices).toHaveLength(2);
      for (const index of timeoutIndices) {
        expect(clearTimer).toHaveBeenCalledWith(setTimer.mock.results[index]?.value);
      }
      await stopProcess(child);
    } finally {
      setTimer.mockRestore();
      clearTimer.mockRestore();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 4_000);

  it.skipIf(process.platform === "win32")(
    "kills a child that ignores SIGTERM",
    async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)",
        ],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      try {
        await once(child, "message");
        await stopProcess(child);
        expect(child.signalCode).toBe("SIGKILL");
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
    10_000,
  );
});

describe("safeName", () => {
  it.each(["基线", "优化后", "日本語", "한글", "مرحبا", "हिन्दी", "𠮷"])(
    "preserves Unicode letters, numbers and combining marks in %s",
    (label) => expect(safeName(label)).toBe(label),
  );

  it("keeps canonically equivalent labels distinct on disk", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "performance-unicode-label-"));
    const labels = ["é", "e\u0301"] as const;
    try {
      expect(safeName(labels[0]).normalize("NFC")).not.toBe(safeName(labels[1]).normalize("NFC"));
      for (const label of labels) {
        await writeFile(path.join(directory, `${safeName(label)}.json`), label);
      }
      expect(await readdir(directory)).toHaveLength(2);
      for (const label of labels) {
        expect(await readFile(path.join(directory, `${safeName(label)}.json`), "utf8")).toBe(label);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains existing ASCII naming and removes unsafe path characters", () => {
    expect(safeName("Baseline V2.0_test")).toBe("baseline-v2.0_test");
    expect(safeName("run-0123456789abcdef")).toBe("run-0123456789abcdef");
    expect(safeName("../基线\\优化后: *?<>|\u0000")).toBe("..-基线-优化后-");
    expect(safeName("中文／路径")).toBe("中文-路径");
    expect(safeName("a/b")).toBe(safeName("a?b"));
  });

  it("writes distinct reports for different Chinese labels", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "performance-label-"));
    const labels = ["基线", "优化后"];
    try {
      for (const label of labels) {
        for (const extension of ["json", "md"]) {
          await writeFile(path.join(directory, `${safeName(label)}.${extension}`), label);
        }
        await writeFile(path.join(directory, `web-chat-${safeName(label)}.json`), label);
      }
      expect(await readdir(directory)).toHaveLength(6);
      for (const label of labels) {
        expect(await readFile(path.join(directory, `${safeName(label)}.json`), "utf8")).toBe(label);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("long performance report labels", () => {
  it("reserves hash-suffixed names for transformed labels", () => {
    const longLabel = "a".repeat(242);
    const shortLabel = safeName(longLabel);
    expect(safeName(shortLabel)).not.toBe(safeName(longLabel));
    expect(Buffer.byteLength(safeName(shortLabel))).toBeLessThanOrEqual(241);
  });

  it.each(["基".repeat(100), "𠮷".repeat(100), "a".repeat(300)])(
    "keeps report filenames within the byte limit",
    async (label) => {
      const directory = await mkdtemp(path.join(tmpdir(), "performance-long-label-"));
      try {
        const stem = safeName(label);
        expect(stem).toBe(safeName(label));
        expect(Buffer.from(stem).toString("utf8")).toBe(stem);
        for (const filename of [`${stem}.json`, `${stem}.md`, `web-chat-${stem}.json`]) {
          await writeFile(path.join(directory, filename), "report");
          expect(Buffer.byteLength(filename)).toBeLessThanOrEqual(255);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("preserves the largest short label and bounds the next byte", () => {
    const boundary = `${"基".repeat(80)}a`;
    expect(Buffer.byteLength(boundary)).toBe(241);
    expect(safeName(boundary)).toBe(boundary);
    expect(Buffer.byteLength(safeName(`${boundary}b`))).toBeLessThanOrEqual(241);
  });

  it("distinguishes long labels that differ only beyond the retained prefix", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "performance-long-label-"));
    const labels = [`${"基".repeat(100)}前`, `${"基".repeat(100)}后`] as const;
    try {
      expect(safeName(labels[0])).not.toBe(safeName(labels[1]));
      for (const label of labels) {
        await writeFile(path.join(directory, `web-chat-${safeName(label)}.json`), label);
      }
      expect(await readdir(directory)).toHaveLength(2);
      for (const label of labels) {
        expect(
          await readFile(path.join(directory, `web-chat-${safeName(label)}.json`), "utf8"),
        ).toBe(label);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
