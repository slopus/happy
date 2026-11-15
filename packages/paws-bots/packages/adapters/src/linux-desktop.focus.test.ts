import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AdapterContext, ComputerAction, ComputerRef } from "@rakazo/adapter-kit";
import { browserProfilePathForScreen } from "@rakazo/core/node/desktop-runtime";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { LinuxDesktop } from "./linux-desktop.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "workspace-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
} as AdapterContext;

const computer = {
  id: "sandbox-1",
  botId: "bot-1",
  kind: "e2b",
  providerRef: "sandbox-1",
} as ComputerRef;

const root = mkdtempSync(path.join(tmpdir(), "linux-desktop-focus-"));
const bin = path.join(root, "bin");
const workspace = path.join(root, "workspace");
const windows = path.join(root, "windows");
const activated = path.join(root, "activated");
const recorded = path.join(root, "recorded");
mkdirSync(bin);
mkdirSync(workspace);
const children: Array<{ kill: () => void }> = [];

function writeExecutable(file: string, body: string) {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

writeExecutable(
  path.join(bin, "wmctrl"),
  [
    "#!/bin/sh",
    'if [ "$1" = "-lxp" ]; then cat "$FOCUS_WINDOWS"; exit 0; fi',
    'if [ "$1" = "-ia" ]; then printf "%s\\n" "$2" > "$FOCUS_ACTIVATED"; exit 0; fi',
    'echo "unexpected wmctrl $*" >&2',
    "exit 1",
    "",
  ].join("\n"),
);

function hold(profile: string) {
  // The flag has to stay on this process. A shell would exec the sleep away.
  const child = spawn(
    "python3",
    ["-c", "import time; time.sleep(30)", `--user-data-dir=${profile}`],
    {
      stdio: "ignore",
    },
  );
  if (!child.pid) throw new Error("profile process failed to start");
  children.push(child);
  return child.pid;
}

async function focusCommand(action: ComputerAction) {
  const runs: string[] = [];
  const desktop = new LinuxDesktop({
    environment: async () => ({
      homeDir: "/home/rakazo",
      workspaceDir: workspace,
      browserProfilesDir: "/home/rakazo/.browser-profiles",
      displayStart: 1,
    }),
    run: async (_computer, command) => {
      runs.push(command);
      if (runs.length === 1) return { code: 0, stdout: "RAKAZO_DESKTOP=0:token\n" };
      return { code: 0, stdout: "" };
    },
    screenUrl: async () => "http://screen.example",
  });
  await desktop.act(computer, { actions: [action], observe: false }, context);
  const command = runs[1];
  if (!command) throw new Error("focus command was not issued");
  return command;
}

function runFocus(command: string) {
  return spawnSync("bash", ["-c", command], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      FOCUS_WINDOWS: windows,
      FOCUS_ACTIVATED: activated,
      FOCUS_RECORDED: recorded,
    },
    encoding: "utf8",
    timeout: 4_000,
  });
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  for (const child of children) child.kill();
  children.length = 0;
  for (const file of [windows, activated, recorded]) rmSync(file, { force: true });
});

describe("provider focus command", () => {
  it("raises an exact WM_CLASS match from the workspace and does not wait on a live launcher", async () => {
    const sleeper = path.join(bin, "sleeper");
    writeExecutable(
      sleeper,
      ["#!/bin/sh", 'echo $$ > "$FOCUS_RECORDED"', "exec sleep 30", ""].join("\n"),
    );
    writeFileSync(
      windows,
      [
        "0x00000001  0 1 uxterm.UXTerm host uxterm",
        "0x00000002  0 2 xterm.XTerm host terminal",
        "",
      ].join("\n"),
    );
    const exact = await focusCommand({ kind: "focus", application: "xterm" });
    expect(exact).toContain(`\ncd '${workspace}'\n`);
    const raised = runFocus(exact);
    expect(raised.status, raised.stderr).toBe(0);
    expect(readFileSync(activated, "utf8").trim()).toBe("0x00000002");

    rmSync(activated, { force: true });
    const command = await focusCommand({
      kind: "focus",
      application: sleeper,
      uri: "notes.txt",
    });
    expect(command).toContain(`\ncd '${workspace}'\n`);
    writeFileSync(windows, "0x00000009  0 9 sleeper.Sleeper host app\n");
    const started = Date.now();
    const result = runFocus(command);
    expect(result.status, result.stderr).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(readFileSync(activated, "utf8").trim()).toBe("0x00000009");
    // Focus can finish before the detached launcher's first write is scheduled.
    let pid = 0;
    await vi.waitFor(
      () => {
        pid = Number(readFileSync(recorded, "utf8").trim());
        expect(pid).toBeGreaterThan(0);
      },
      { timeout: 5_000, interval: 20 },
    );
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The background launcher may already have exited.
    }
  });

  it("launches an app with no window without waiting for it to exit", async () => {
    const sleeper = path.join(bin, "sleeper");
    writeExecutable(
      sleeper,
      ["#!/bin/sh", 'echo $$ > "$FOCUS_RECORDED"', "exec sleep 30", ""].join("\n"),
    );
    writeFileSync(windows, "");
    const started = Date.now();
    const result = runFocus(await focusCommand({ kind: "focus", application: sleeper }));
    expect(result.status, result.stderr).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
    let pid = 0;
    await vi.waitFor(
      () => {
        pid = Number(readFileSync(recorded, "utf8").trim());
        expect(pid).toBeGreaterThan(0);
      },
      { timeout: 5_000, interval: 20 },
    );
    process.kill(pid, "SIGTERM");
  });

  it("opens a workspace file as a tab in the screen's browser without waiting on a viewer", async () => {
    // The image's xdg-open hands a file to a viewer and lives as long as it does.
    writeExecutable(
      path.join(bin, "xdg-open"),
      ["#!/bin/sh", 'printf "%s\\n" "$1" > "$FOCUS_RECORDED"', "exec sleep 8", ""].join("\n"),
    );
    writeFileSync(path.join(workspace, "shot.png"), "png");
    const command = await focusCommand({ kind: "open", path: "shot.png" });
    expect(command).toContain(
      `nohup /tmp/rakazo/browser-launch-1 '${pathToFileURL(path.join(workspace, "shot.png")).href}'`,
    );
    const started = Date.now();
    const result = runFocus(command);
    expect(result.status, result.stderr).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(() => readFileSync(recorded, "utf8")).toThrow();
  });

  it("fails an open at once when the workspace file does not exist", async () => {
    writeExecutable(path.join(bin, "xdg-open"), "#!/bin/sh\nexec sleep 8\n");
    const command = await focusCommand({ kind: "open", path: "missing.png" });
    const result = runFocus(command);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("does not exist");
  });

  it("resolves a workspace-relative program when no window matches", async () => {
    writeExecutable(
      path.join(workspace, "tool"),
      ["#!/bin/sh", 'pwd > "$FOCUS_RECORDED"', 'printf "%s\\n" "$*" >> "$FOCUS_RECORDED"', ""].join(
        "\n",
      ),
    );
    writeFileSync(windows, "");
    const command = await focusCommand({
      kind: "focus",
      application: "./tool",
      uri: "notes.txt",
    });
    const result = runFocus(command);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(recorded, "utf8").trim().split("\n")).toEqual([workspace, "notes.txt"]);
  });

  it.skipIf(process.platform !== "linux")(
    "raises the browser window for this screen's profile",
    async () => {
      const env = {
        homeDir: "/home/rakazo",
        workspaceDir: workspace,
        browserProfilesDir: "/home/rakazo/.browser-profiles",
        displayStart: 1,
      };
      const mine = browserProfilePathForScreen("bot-1", env);
      const other = `${mine}-other`;
      const otherPid = hold(other);
      const minePid = hold(mine);
      writeFileSync(
        windows,
        [
          `0x0000000a  0 ${otherPid} chromium.Chromium host Other`,
          `0x0000000b  0 ${minePid} chromium.Chromium host Mine`,
          "",
        ].join("\n"),
      );
      const command = await focusCommand({ kind: "focus", application: "chromium" });
      expect(command).toContain(`CHROME_USER_DATA_DIR='${mine}'`);
      expect(command).not.toContain(`\ncd '${workspace}'\n`);
      const result = runFocus(command);
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(activated, "utf8").trim()).toBe("0x0000000b");
    },
  );

  it("raises the Chromium window launch opened for the firefox alias", async () => {
    writeFileSync(
      windows,
      [
        "0x00000007  0 7 Navigator.Firefox host Firefox",
        "0x0000000c  0 12 chromium.Chromium host Browser",
        "",
      ].join("\n"),
    );
    const command = await focusCommand({
      kind: "focus",
      application: "firefox",
      uri: "https://example.test",
    });
    expect(command).toContain("nohup /tmp/rakazo/browser-launch-1 'https://example.test'");
    expect(command).toContain(
      "in chromium|chromium-browser|google-chrome|google-chrome-stable|chrome|brave-browser)",
    );
    expect(command).not.toContain("in firefox)");
    expect(command).not.toContain(`\ncd '${workspace}'\n`);
    const result = runFocus(command);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(activated, "utf8").trim()).toBe("0x0000000c");
  });

  it("fails a focus URI when the launcher exits before the old window is raised", async () => {
    const failapp = path.join(bin, "failapp");
    writeExecutable(failapp, "#!/bin/sh\nexit 1\n");
    writeFileSync(windows, "0x00000004  0 4 failapp.Failapp host app\n");
    const command = await focusCommand({
      kind: "focus",
      application: failapp,
      uri: "notes.txt",
    });
    const result = runFocus(command);
    expect(result.status, result.stderr).not.toBe(0);
    expect(() => readFileSync(activated, "utf8")).toThrow();
  });
});
