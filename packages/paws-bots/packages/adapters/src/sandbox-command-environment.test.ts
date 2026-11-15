import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { sandboxCommandArgv, sandboxCommandEnvironment } from "./sandbox-command-environment.js";

describe("sandbox command environment", () => {
  it("removes inherited and request values without mutating either input", () => {
    const inherited = { FAILED: "fake-host", HOST_ONLY: "fake-host-only" };
    const request = {
      env: { FAILED: "fake-space", GOOD: "fake-bot" },
      unsetEnv: ["FAILED"],
    };
    expect(sandboxCommandEnvironment(request, inherited)).toEqual({
      HOST_ONLY: "fake-host-only",
      GOOD: "fake-bot",
    });
    expect(inherited.FAILED).toBe("fake-host");
    expect(request.env.FAILED).toBe("fake-space");
  });

  it("removes differently cased inherited names on Windows", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    try {
      expect(
        sandboxCommandEnvironment(
          { env: { FAILED: "fake-space" }, unsetEnv: ["FAILED"] },
          { Failed: "fake-host", GOOD: "fake-good" },
        ),
      ).toEqual({ GOOD: "fake-good" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Linux command translation removes variables after the SDK overlay", () => {
    const argv = sandboxCommandArgv({
      argv: [
        process.execPath,
        "-e",
        "process.exit(Object.hasOwn(process.env, 'FAILED') || process.env.GOOD !== 'fake-bot' ? 1 : 0)",
      ],
      unsetEnv: ["FAILED"],
    });
    const result = spawnSync(argv[0]!, argv.slice(1), {
      env: { ...process.env, FAILED: "fake-overlay", GOOD: "fake-bot" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.length + result.stderr.length).toBe(0);
    expect(sandboxCommandArgv({ argv: ["ls"], unsetEnv: [] })).toEqual(["ls"]);
  });
});
