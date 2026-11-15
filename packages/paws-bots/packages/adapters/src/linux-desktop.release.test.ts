import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { BROWSER_STILL_RUNNING_EXIT } from "@rakazo/core/node/desktop-runtime";
import { describe, expect, it } from "vitest";
import { BrowserStillRunningError, BrowserStoppedReleaseError } from "./computer-screens.js";
import { LinuxDesktop } from "./linux-desktop.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "workspace-1",
  userId: "user-1",
  botId: "bot-1",
  screenLeaseId: "run-1:1",
  signal: new AbortController().signal,
} as AdapterContext;

const computer = {
  id: "sandbox-1",
  botId: "team-workspace-1",
  kind: "e2b",
  providerRef: "sandbox-1",
} as ComputerRef;

type Result = { code: number; stdout: string; stderr?: string };

function host(result: Result | ((command: string) => Result), commands: string[] = []) {
  return {
    environment: async () => ({
      homeDir: "/home/rakazo",
      workspaceDir: "/home/rakazo",
      browserProfilesDir: "/home/rakazo/.browser-profiles",
      displayStart: 1,
    }),
    run: async (_computer: ComputerRef, command: string) => {
      commands.push(command);
      return typeof result === "function" ? result(command) : result;
    },
    screenUrl: async () => "http://screen.example",
  };
}

const releasesBrowser = (command: string) => command.includes("RAKAZO_DESKTOP_RELEASED");

describe("LinuxDesktop.releaseScreen", () => {
  it("reports the browser stopped when slot cleanup fails after the release marker", async () => {
    const desktop = new LinuxDesktop(
      host({ code: 1, stdout: "RAKAZO_DESKTOP_RELEASED=0\n", stderr: "slot lock failed" }),
    );

    await expect(desktop.releaseScreen(computer, context)).rejects.toBeInstanceOf(
      BrowserStoppedReleaseError,
    );
  });

  it("keeps a release that never stops the browser as a failure", async () => {
    const desktop = new LinuxDesktop(
      host({ code: 1, stdout: "", stderr: "browser still running" }),
    );

    await expect(desktop.releaseScreen(computer, context)).rejects.toThrow("browser still running");
  });

  it.each([0, 75])(
    "revokes only control for a completed run and keeps its browser (exit %s)",
    async (code) => {
      const commands: string[] = [];
      const desktop = new LinuxDesktop(host({ code, stdout: "" }, commands));

      await desktop.releaseScreen(computer, { ...context, keepScreenWarm: true });

      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain("run-1:1");
      expect(commands[0]).toContain("control-token-");
      expect(releasesBrowser(commands[0]!)).toBe(false);
    },
  );

  it("tears the screen down when control revocation fails", async () => {
    const commands: string[] = [];
    const desktop = new LinuxDesktop(
      host(
        (command) =>
          releasesBrowser(command) ? { code: 0, stdout: "" } : { code: 1, stdout: "", stderr: "x" },
        commands,
      ),
    );

    await desktop.releaseScreen(computer, { ...context, keepScreenWarm: true });

    expect(commands.map(releasesBrowser)).toEqual([false, true]);
  });

  it.each<[string, Partial<AdapterContext>]>([
    ["canceled", { keepScreenWarm: true, cancelRunWork: true }],
    ["aborted", { keepScreenWarm: true, signal: AbortSignal.abort() }],
    ["failed", {}],
  ])("tears down the browser for a %s run", async (_name, overrides) => {
    const commands: string[] = [];
    const desktop = new LinuxDesktop(host({ code: 0, stdout: "" }, commands));

    await desktop.releaseScreen(computer, { ...context, ...overrides });

    expect(commands.map(releasesBrowser)).toEqual([true]);
  });
});

describe("LinuxDesktop.connectScreen", () => {
  it("keeps the exit code of a desktop command that failed without stderr", async () => {
    const desktop = new LinuxDesktop(host({ code: 137, stdout: "", stderr: "" }));

    const error = await desktop
      .connectScreen(computer, { view: "stream" }, context)
      .catch((caught) => caught);

    expect(error.message).toBe("computer desktop operation failed");
    expect(error.cause.message).toBe("exit 137");
  });
});

describe("LinuxDesktop.stopBrowsers", () => {
  it("names a browser that is open again so the save can wait for it", async () => {
    const desktop = new LinuxDesktop(
      host({ code: BROWSER_STILL_RUNNING_EXIT, stdout: "", stderr: "browser still running\n" }),
    );

    await expect(desktop.stopBrowsers(computer, context)).rejects.toBeInstanceOf(
      BrowserStillRunningError,
    );
  });
});
