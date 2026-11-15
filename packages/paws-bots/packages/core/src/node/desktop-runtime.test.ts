import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BROWSER_STILL_RUNNING_EXIT,
  browserCloseProgram,
  browserProfilePathForScreen,
  DEFAULT_DESKTOP_ENV,
  desktopControlCommand,
  desktopTerminalCommand,
  desktopUrl,
  desktopWorkCommand,
  ensureScreenCommand,
  interactiveScreenCommand,
  MAX_DESKTOP_DISPLAY,
  managedDesktopCommand,
  quiesceBrowserProfilesCommand,
  releaseDesktopCommand,
  resetDesktopRuntimeCommand,
  screenDisplayArgv,
  screenPorts,
  shellQuote,
  stopBrowserProfileCommand,
  stopExtraScreenCommand,
  TERMINAL_MENU_COMMAND,
  terminalCommand,
} from "./desktop-runtime.js";

const JOINED_COMMAND = `import os, time
raw = open("/proc/self/cmdline", "rb").read().rstrip(b"\\0")
joined = raw.replace(b"\\0", b" ")
start = end = None
for line in open("/proc/self/maps"):
    if "[stack]" in line:
        a, b = line.split()[0].split("-")
        start, end = int(a, 16), int(b, 16)
        break
mem = os.open("/proc/self/mem", os.O_RDWR)
pos = end
found = None
while pos > start:
    size = min(1024 * 1024, pos - start)
    pos -= size
    os.lseek(mem, pos, os.SEEK_SET)
    data = os.read(mem, size + len(raw))
    idx = data.find(raw)
    if idx != -1:
        found = pos + idx
        break
if found is None:
    raise SystemExit("cmdline not found")
os.lseek(mem, found, os.SEEK_SET)
os.write(mem, joined)
os.close(mem)
open(os.environ["JOINED_READY"], "w").write("ready\\n")
time.sleep(120)
`;

function waitForReady(file: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (spawnSync("test", ["-s", file]).status === 0) return;
    spawnSync("sleep", ["0.02"]);
  }
  throw new Error("space-joined command line was not published");
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const env = {
  homeDir: "/home/user",
  workspaceDir: "/home/user/work",
  browserProfilesDir: "/home/user/work/.browser-profiles",
  displayStart: 20,
  portStart: 6100,
};

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "desktop-runtime-test-"));
  roots.push(root);
  const run = (script: string, failLifecycle = false, input?: string) =>
    spawnSync(
      "bash",
      [
        "-eu",
        "-c",
        [
          // Lifecycle processes are stubbed here; the opt-in Docker smoke runs the real commands.
          "flock() { :; }",
          `bash() { return ${failLifecycle ? 1 : 0}; }`,
          script
            .replaceAll("/tmp/rakazo/desktop-assignments", root)
            .replaceAll("/tmp/rakazo", root),
        ].join("\n"),
      ],
      { encoding: "utf8", timeout: 5000, input },
    );
  const ensure = (bot: string, lease = "run:1", fail = false) =>
    run(managedDesktopCommand(bot, lease, env, `view-${bot}`), fail);
  const release = (bot: string, lease = "run:1", fail = false) =>
    run(releaseDesktopCommand(bot, lease, env), fail);
  return { root, run, ensure, release };
}

describe("shared Linux desktop lifecycle", () => {
  it("runs work on the matching assignment without changing its lease and preserves stdin", () => {
    const f = fixture();
    expect(f.ensure("a").status).toBe(0);
    const result = f.run(
      desktopWorkCommand("a", "run:1", 0, "cat; exit 7"),
      false,
      "private input\n",
    );
    expect(result.stdout).toBe("private input\n");
    expect(result.status).toBe(7);
    expect(f.run(desktopWorkCommand("a", undefined, 0, "printf unleased")).stdout).toBe("unleased");
    const slot = readdirSync(f.root).find((name) => name.endsWith(".slot"))!;
    expect(readFileSync(path.join(f.root, slot), "utf8")).toBe("0\nrun:1\nview-a\n");
  });

  it("refuses delayed work after its removed slot has been reused", () => {
    const f = fixture();
    expect(f.ensure("a").status).toBe(0);
    const work = desktopWorkCommand("a", "run:1", 0, 'printf touched >"$dir/touched"');
    expect(f.release("a").status).toBe(0);
    expect(f.ensure("b").stdout).toContain("RAKAZO_DESKTOP=0:view-b");
    expect(f.run(work).status).toBe(75);
    expect(readdirSync(f.root)).not.toContain("touched");
  });

  it("refuses delayed work after its screen is assigned a different slot", () => {
    const f = fixture();
    expect(f.ensure("a").status).toBe(0);
    const work = desktopWorkCommand("a", "run:1", 0, 'printf touched >"$dir/touched"');
    expect(f.release("a").status).toBe(0);
    expect(f.ensure("b").status).toBe(0);
    expect(f.ensure("a").stdout).toContain("RAKAZO_DESKTOP=1:view-a");
    expect(f.run(work).status).toBe(75);
    expect(readdirSync(f.root)).not.toContain("touched");
  });

  it.each([
    ["new:2", "run:1"],
    ["run:1", "new:2"],
    ["run:1", ""],
  ])("requires the exact work lease without replacing %s with %s", (current, incoming) => {
    const f = fixture();
    expect(f.ensure("a", current).status).toBe(0);
    const work = desktopWorkCommand("a", incoming, 0, 'printf touched >"$dir/touched"');
    expect(f.run(work).status).toBe(75);
    expect(readdirSync(f.root)).not.toContain("touched");
    const slot = readdirSync(f.root).find((name) => name.endsWith(".slot"))!;
    expect(readFileSync(path.join(f.root, slot), "utf8")).toBe(`0\n${current}\nview-a\n`);
  });

  it.skipIf(process.platform !== "linux")(
    "keeps a helper's slot reserved until its lifecycle lock is released",
    async () => {
      const f = fixture();
      expect(f.ensure("a").status).toBe(0);
      const relocate = (command: string) =>
        command
          .replaceAll("/tmp/rakazo/desktop-assignments", f.root)
          .replaceAll("/tmp/rakazo", f.root);
      const ready = path.join(f.root, "helper-ready");
      const releasing = path.join(f.root, "release-ready");
      const helper = spawn("bash", [
        "-eu",
        "-c",
        relocate(
          desktopWorkCommand("a", "run:1", 0, `printf ready >${shellQuote(ready)}; read -r done`),
        ),
      ]);
      const helperExited = once(helper, "exit");
      let release: ChildProcess | undefined;
      try {
        waitForReady(ready);
        const lifecycle = readdirSync(f.root).find((name) => name.endsWith(".lifecycle-lock"))!;
        expect(spawnSync("flock", ["-n", path.join(f.root, lifecycle), "true"]).status).toBe(1);
        expect(spawnSync("flock", ["-n", path.join(f.root, ".lock"), "true"]).status).toBe(0);
        release = spawn("bash", [
          "-eu",
          "-c",
          [
            `printf ready >${shellQuote(releasing)}`,
            "bash() { return 0; }",
            relocate(releaseDesktopCommand("a", "run:1", env)),
          ].join("\n"),
        ]);
        const releaseExited = once(release, "exit");
        waitForReady(releasing);
        expect(f.ensure("b").stdout).toContain("RAKAZO_DESKTOP=1:view-b");
        helper.stdin.end("done\n");
        expect((await helperExited)[0]).toBe(0);
        expect((await releaseExited)[0]).toBe(0);
        expect(f.ensure("c").stdout).toContain("RAKAZO_DESKTOP=0:view-c");
      } finally {
        helper.kill("SIGKILL");
        release?.kill("SIGKILL");
      }
    },
  );

  it("defaults to a loopback gateway without environment options", () => {
    expect(ensureScreenCommand(0, "bot", "view")).toContain("127.0.0.1:6080 8>&-");
    expect(interactiveScreenCommand(true, "control")).toContain("127.0.0.1:6080 8>&-");
    expect(terminalCommand("control", "terminal", "/work")).toContain("127.0.0.1:6080 8>&-");
  });

  it("sends screen changes sooner only while a person has control", () => {
    expect(interactiveScreenCommand(true, "control")).toMatch(
      /x11vnc -display [^\n]* -wait 5 -defer 5 /,
    );
    expect(ensureScreenCommand(0, "bot", "view")).not.toMatch(/-wait 5|-defer 5/);
  });

  it.each([undefined, "127.0.0.1", "localhost", "192.0.2.10", "0.0.0.0"])(
    "binds and identifies the configured gateway (%s)",
    (bindHost) => {
      const environment = { ...env, bindHost };
      const host = bindHost ?? "127.0.0.1";
      const command = terminalCommand("control", "terminal", "/work", environment);
      expect(command).toContain(`--token-source=/tmp/rakazo/desktop-targets ${host}:6100 8>&-`);
      const pattern = command.match(/if ! pgrep -f '([^']+)'/)?.[1];
      expect(pattern).toBeDefined();
      const process = (address: string, source = "desktop-targets") =>
        `/usr/bin/python3 /usr/bin/websockify --token-source=/tmp/rakazo/${source} ${address}:6100`;
      expect(process(host)).toMatch(new RegExp(pattern!));
      expect(process("192x0x2x10")).not.toMatch(new RegExp(pattern!));
      expect(process(host, "view-target-1")).not.toMatch(new RegExp(pattern!));
      if (host !== "0.0.0.0") expect(process("0.0.0.0")).not.toMatch(new RegExp(pattern!));
      // Retirement still matches older wildcard listeners, including single-screen images.
      const retirement = command.match(/pkill -f '([^']*websockify[^']*)'/)?.[1];
      expect(retirement).toBeDefined();
      expect(process("0.0.0.0", "view-target-1")).toMatch(new RegExp(retirement!));
      expect(process("0.0.0.0")).toMatch(new RegExp(retirement!));
      expect(command).toContain(`/dev/tcp/${host === "0.0.0.0" ? "127.0.0.1" : host}/6100`);
      expect(ensureScreenCommand(0, "bot", "view", environment)).toContain(`${host}:6100 8>&-`);
      expect(interactiveScreenCommand(true, "control", screenPorts(0, environment))).toContain(
        `${host}:6100 8>&-`,
      );
    },
  );

  it("binds IPv6 computer gateways and probes IPv6 loopback", () => {
    const command = terminalCommand("control", "terminal", "/work", { ...env, bindHost: "::" });
    expect(command).toContain("--token-source=/tmp/rakazo/desktop-targets :::6100 8>&-");
    expect(command).toContain("/dev/tcp/::1/6100");
  });

  it.each([
    "",
    "example.test",
    "256.1.1.1",
    "127.1",
    "::1",
    "127.0.0.1; touch /tmp/injected",
    "localhost\n",
  ])("rejects invalid gateway hosts (%j)", (bindHost) => {
    const environment = { ...env, bindHost };
    expect(() => ensureScreenCommand(0, "bot", "view", environment)).toThrow(
      "invalid screen gateway bind host",
    );
    expect(() => terminalCommand("control", "terminal", "/work", environment)).toThrow(
      "invalid screen gateway bind host",
    );
    expect(() =>
      interactiveScreenCommand(true, "control", { ...screenPorts(0), bindHost }),
    ).toThrow("invalid screen gateway bind host");
  });

  it.skipIf(process.platform !== "linux")(
    "runs a bot's commands on its own assigned display",
    () => {
      const f = fixture();
      f.ensure("becky");
      f.ensure("beto");
      const run = (bot: string, argv: string[]) => {
        const [program, ...args] = screenDisplayArgv(argv, bot, env.displayStart).map((word) =>
          word.replaceAll("/tmp/rakazo/desktop-assignments", f.root),
        );
        return spawnSync(program ?? "", args, {
          encoding: "utf8",
          env: { PATH: process.env.PATH, DISPLAY: ":1" },
        });
      };
      const printDisplay = ["sh", "-c", 'printf "%s|%s" "$DISPLAY" "$1"', "sh", "a b'c $HOME"];

      expect(run("becky", printDisplay).stdout).toBe(":20|a b'c $HOME");
      expect(run("beto", printDisplay).stdout).toBe(":21|a b'c $HOME");
      // No screen yet: the command keeps the display it inherited.
      expect(run("tori", printDisplay).stdout).toBe(":1|a b'c $HOME");
      writeFileSync(
        path.join(f.root, `${createHash("sha256").update("bad").digest("hex").slice(0, 32)}.slot`),
        "x;1\n",
      );
      expect(run("bad", printDisplay).stdout).toBe(":1|a b'c $HOME");
      expect(run("beto", ["sh", "-c", "exit 7"]).status).toBe(7);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "allocates live slots past 1000 bots, keeps assignments across callers, and rejects stale leases",
    () => {
      const f = fixture();
      expect(f.ensure("a").stdout).toContain("RAKAZO_DESKTOP=0:view-a");
      expect(f.ensure("b").stdout).toContain("RAKAZO_DESKTOP=1:view-b");
      expect(f.ensure("a", "new:2").stdout).toContain("RAKAZO_DESKTOP=0:view-a");
      expect(f.ensure("a", "run:1").status).toBe(75);
      expect(f.release("a", "run:3").status).toBe(75);
      expect(f.release("a", "new:1").status).toBe(75);
      for (let i = 2; i < 1000; i++)
        writeFileSync(path.join(f.root, `seed-${i}.slot`), `${i}\nseed:1\nunused\n`);
      expect(f.ensure("bot-1000").stdout).toContain("RAKAZO_DESKTOP=1000:view-bot-1000");
      expect(f.release("a", "new:2").status).toBe(0);
      expect(f.ensure("c").stdout).toContain("RAKAZO_DESKTOP=0:view-c");
      expect(f.ensure("b").stdout).toContain("RAKAZO_DESKTOP=1:view-b");
    },
  );

  it.skipIf(process.platform !== "linux")(
    "keeps the slot when the shared registry lock cannot be reacquired after the browser stops",
    () => {
      const f = fixture();
      expect(f.ensure("a").status).toBe(0);
      expect(readdirSync(f.root).some((name) => name.endsWith(".slot"))).toBe(true);
      const script = releaseDesktopCommand("a", "run:1", env)
        .replaceAll("/tmp/rakazo/desktop-assignments", f.root)
        .replaceAll("/tmp/rakazo", f.root);
      const result = spawnSync(
        "bash",
        [
          "-eu",
          "-c",
          [
            "calls=0",
            "flock() {",
            '  if [ "$1" = "-u" ]; then return 0; fi',
            "  calls=$((calls + 1))",
            '  if [ "$calls" -ge 3 ]; then echo "slot lock failed" >&2; return 1; fi',
            "  return 0",
            "}",
            "bash() { return 0; }",
            script,
          ].join("\n"),
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("RAKAZO_DESKTOP_RELEASED=");
      expect(readdirSync(f.root).some((name) => name.endsWith(".slot"))).toBe(true);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "reports slot removal failure after the browser has stopped",
    () => {
      const f = fixture();
      expect(f.ensure("a").status).toBe(0);
      const script = releaseDesktopCommand("a", "run:1", env)
        .replaceAll("/tmp/rakazo/desktop-assignments", f.root)
        .replaceAll("/tmp/rakazo", f.root);
      const result = spawnSync(
        "bash",
        [
          "-eu",
          "-c",
          [
            "flock() { :; }",
            "bash() { return 0; }",
            "rm() { echo 'slot remove failed' >&2; return 1; }",
            script,
          ].join("\n"),
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("RAKAZO_DESKTOP_RELEASED=");
      expect(readdirSync(f.root).some((name) => name.endsWith(".slot"))).toBe(true);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "reserves failed startup and teardown slots until a successful retry",
    () => {
      const f = fixture();
      expect(f.ensure("a", "run:1", true).status).toBe(1);
      expect(f.ensure("b").stdout).toContain("RAKAZO_DESKTOP=1:view-b");
      expect(f.ensure("a").stdout).toContain("RAKAZO_DESKTOP=0:view-a");
      const failedRelease = f.release("a", "run:1", true);
      expect(failedRelease.status).toBe(1);
      expect(failedRelease.stdout).not.toContain("RAKAZO_DESKTOP_RELEASED=");
      expect(f.ensure("c").stdout).toContain("RAKAZO_DESKTOP=2:view-c");
      expect(f.release("a").status).toBe(0);
      expect(f.ensure("d").stdout).toContain("RAKAZO_DESKTOP=0:view-d");
    },
  );

  it.skipIf(process.platform !== "linux")(
    "does not create a screen on control release and keeps newer fences",
    () => {
      const f = fixture();
      expect(f.run(desktopControlCommand("missing", "run:1", env, false, "token")).status).toBe(0);
      expect(readdirSync(f.root).filter((name) => name.endsWith(".slot"))).toEqual([]);
      expect(f.ensure("a", "new:2").status).toBe(0);
      expect(f.run(desktopControlCommand("a", "old:1", env, true, "token")).status).toBe(75);
      const slot = readdirSync(f.root).find((name) => name.endsWith(".slot"))!;
      expect(readFileSync(path.join(f.root, slot), "utf8")).toContain("new:2");
    },
  );

  it.skipIf(process.platform !== "linux")(
    "keeps a completed run's display for that bot's next run and rejects its stale fence",
    () => {
      const f = fixture();
      expect(f.ensure("a", "run:1").stdout).toContain("RAKAZO_DESKTOP=0:view-a");
      expect(f.run(desktopControlCommand("a", "run:1", env, false)).status).toBe(0);
      const slot = readdirSync(f.root).find((name) => name.endsWith(".slot"))!;
      expect(readFileSync(path.join(f.root, slot), "utf8")).toBe("0\nrun:1\nview-a\n");
      expect(f.ensure("b").stdout).toContain("RAKAZO_DESKTOP=1:view-b");
      expect(f.ensure("a", "next:2").stdout).toContain("RAKAZO_DESKTOP=0:view-a");
      expect(f.run(desktopControlCommand("a", "run:1", env, false)).status).toBe(75);
      expect(f.release("a", "run:1").status).toBe(75);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "opens a terminal only on an assigned display under the current lease",
    () => {
      const f = fixture();
      expect(f.run(desktopTerminalCommand("missing", "run:1", env, "c", "t", ".")).status).toBe(75);
      expect(f.ensure("a").status).toBe(0);
      expect(f.run(desktopTerminalCommand("a", "old:0", env, "c", "t", ".")).status).toBe(75);
      expect(f.run(desktopTerminalCommand("a", "run:1", env, "c", "t", ".")).status).toBe(0);
      expect(() => terminalCommand("c", "bad token", ".")).toThrow("invalid terminal token");
    },
  );

  it("drops libnss_wrapper before the screen browser exec", () => {
    const command = ensureScreenCommand(0, "bot", "token");
    expect(command).toContain("*libnss_wrapper.so");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    expect(command).toContain("${_rest%%[: ]*}");
    expect(command).toContain("unset LD_PRELOAD");
    expect(command).toContain('[ "$(cat /tmp/rakazo/desktop-targets/view-1)" != "$desired" ]');
    expect(command).toContain(
      "browser=$(command -v rakazo-browser || command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser)",
    );
    const lines = command.split("\n");
    const unsetAt = lines.findIndex((line) => line.includes("unset LD_PRELOAD"));
    const execAt = lines.findIndex((line) => line.startsWith("exec "));
    expect(unsetAt).toBeGreaterThan(-1);
    expect(execAt).toBeGreaterThan(unsetAt);
    // A relaunch keeps the bot's tabs and session cookies, matching rakazo-browser.
    expect(lines[execAt]).toContain("--restore-last-session");
  });

  it.skipIf(process.platform !== "linux").each([
    ["readable", false],
    ["readable", true],
    ["missing", false],
    // An unreadable image menu falls back instead of failing the screen. Root reads any mode.
    ...(process.getuid?.() === 0 ? [] : [["unreadable", false] as const]),
  ] as const)(
    "writes a screen's menu from the image menu with its own browser launcher (imageMenu=%s, managed=%s)",
    (imageMenu, managed) => {
      const root = mkdtempSync(path.join(tmpdir(), "desktop-menu-test-"));
      roots.push(root);
      if (imageMenu !== "missing") {
        writeFileSync(
          path.join(root, "image-menu"),
          [
            "[begin] (Rakazo)",
            "  [exec] (Browser) {rakazo-browser}",
            "  [exec] (Docs) {rakazo-browser https://example.test}",
            "  [exec] (Files) {pcmanfm}",
            "  [exec] (Other) {rakazo-browser-beta}",
            "[end]",
            "",
          ].join("\n"),
          { mode: imageMenu === "readable" ? 0o644 : 0 },
        );
      }
      const script = (
        managed
          ? managedDesktopCommand("bot", "run:1", env, "token")
          : ensureScreenCommand(0, "bot", "token", env)
      )
        .replaceAll("/etc/rakazo/fluxbox/menu", path.join(root, "image-menu"))
        .replaceAll("/tmp/fluxbox-home-", path.join(root, "flux-"))
        .replaceAll("/tmp/rakazo", root)
        .replaceAll("/usr/share/novnc", root);
      const result = spawnSync(
        "bash",
        [
          "-c",
          // Stop right after the menu is written; the managed path runs it in a child bash.
          ["command() { :; }", "xdpyinfo() { exit 0; }", "export -f command xdpyinfo", script].join(
            "\n",
          ),
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      expect(result.status, result.stderr).toBe(0);
      const launcher = path.join(root, "browser-launch-20");
      expect(readFileSync(path.join(root, "flux-20/.fluxbox/menu"), "utf8")).toBe(
        imageMenu === "readable"
          ? [
              "[begin] (Rakazo)",
              `  [exec] (Browser) {${launcher}}`,
              `  [exec] (Docs) {${launcher} https://example.test}`,
              "  [exec] (Files) {pcmanfm}",
              "  [exec] (Other) {rakazo-browser-beta}",
              "[end]",
              "",
            ].join("\n")
          : `[begin] (Desktop)\n[exec] (Browser) {${launcher}}\n[exec] (Terminal) {${TERMINAL_MENU_COMMAND}}\n[end]\n`,
      );
    },
  );

  it("starts a screen's window manager with a wallpaper setter that cannot open an error dialog", () => {
    const root = mkdtempSync(path.join(tmpdir(), "desktop-wallpaper-test-"));
    roots.push(root);
    const bin = path.join(root, "bin");
    const log = path.join(root, "log");
    mkdirSync(bin);
    const stub = (name: string, body: string) =>
      writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    stub("Xvfb", "exit 0");
    stub("websockify", "exit 0");
    stub("xsetroot", `echo "xsetroot $*" >>"${log}"`);
    // A stock image's style asks for its wallpaper like this.
    stub(
      "fluxbox",
      `echo "fbsetbg=$(command -v fbsetbg)" >>"${log}"\nfbsetbg -z -f /usr/share/images/fluxbox/debian-squared.jpg`,
    );
    const script = ensureScreenCommand(0, "bot", "token", env)
      .replaceAll("/etc/rakazo/", path.join(root, "image/"))
      .replaceAll("/tmp/fluxbox-home-", path.join(root, "flux-"))
      .replaceAll("/tmp/.X", path.join(root, ".X"))
      .replaceAll("/tmp/rakazo", root)
      .replaceAll("/usr/share/novnc", root);
    const result = spawnSync(
      "bash",
      [
        "-c",
        // The display is down on the first check; stop once the window manager has started.
        [
          "checks=0",
          'xdpyinfo() { checks=$((checks + 1)); if [ "$checks" -ge 4 ]; then wait; exit 0; fi; [ "$checks" -gt 1 ]; }',
          script,
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(log, "utf8")).toBe(
      `fbsetbg=${path.join(root, "flux-20/bin/fbsetbg")}\nxsetroot -solid #111113\n`,
    );
  });

  it.skipIf(process.platform !== "linux").each([false, true])(
    "repairs an empty control route or fails if publication fails (failPublish=%s)",
    async (failPublish) => {
      const root = mkdtempSync("/tmp/rk-control-");
      roots.push(root);
      mkdirSync(path.join(root, "sockets"));
      mkdirSync(path.join(root, "desktop-targets"));
      const socket = path.join(
        root,
        `sockets/control-1-${createHash("sha256").update("human").digest("hex").slice(0, 32)}`,
      );
      const input = net.createServer();
      const gateway = net.createServer((connection) => connection.destroy());
      await new Promise<void>((resolve) => input.listen(socket, resolve));
      await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
      const address = gateway.address();
      if (!address || typeof address === "string") throw new Error("expected port");
      writeFileSync(path.join(root, "control-token-1"), "human");
      writeFileSync(path.join(root, "desktop-targets/control-1"), "");
      try {
        const script = interactiveScreenCommand(true, "human", {
          ...screenPorts(0),
          controlPort: String(address.port),
        })
          .replaceAll("/tmp/rakazo", root)
          .replaceAll("/usr/share/novnc", root);
        const result = spawnSync(
          "bash",
          [
            "-c",
            [
              ...(failPublish ? ["mv() { return 1; }"] : []),
              "pgrep() { return 0; }",
              "pkill() { echo unexpected-stop >&2; return 1; }",
              "flock() { :; }",
              "command() { echo /fake/websockify; }",
              script,
            ].join("\n"),
          ],
          { encoding: "utf8", timeout: 5000 },
        );
        expect(result.status, result.stderr).toBe(failPublish ? 1 : 0);
        expect(result.stderr).not.toContain("unexpected-stop");
        if (failPublish) return;
        expect(readFileSync(path.join(root, "desktop-targets/control-1"), "utf8")).toBe(
          `human: unix_socket:${socket}\n`,
        );
      } finally {
        input.close();
        gateway.close();
      }
    },
  );

  it("fails without publishing a token when the input server cannot start", () => {
    const root = mkdtempSync("/tmp/rk-control-");
    roots.push(root);
    const script = interactiveScreenCommand(true, "human").replaceAll("/tmp/rakazo", root);
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "nohup() { return 1; }",
          "pgrep() { return 1; }",
          "pkill() { :; }",
          "sleep() { :; }",
          script,
        ].join("\n"),
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    expect(result.status).not.toBe(0);
    expect(() => readFileSync(path.join(root, "control-token-1"))).toThrow();
  });

  it("stops the terminal with the control lease and the screen transports", () => {
    expect(interactiveScreenCommand(false)).toMatch(/pkill -f .*rakazo-terminal\.py/);
    expect(interactiveScreenCommand(false)).toContain("desktop-targets/terminal-1");
    expect(stopExtraScreenCommand(1, "a")).toMatch(/pkill -f .*sockets\/terminal-2-/);
  });

  it.skipIf(process.platform !== "linux").each([DEFAULT_DESKTOP_ENV, env])(
    "generates valid shell for every lifecycle operation ($displayStart)",
    (environment) => {
      for (const command of [
        ensureScreenCommand(0, "bot's id", "token", environment),
        ensureScreenCommand(1, "bot's id", "token", environment),
        managedDesktopCommand("bot's id", "run:1", environment, "token"),
        releaseDesktopCommand("bot's id", "run:1", environment),
        desktopControlCommand("bot's id", "run:1", environment, true, "token"),
        desktopTerminalCommand("bot's id", "run:1", environment, "token", "terminal", "bots/a'b"),
        terminalCommand("token", "terminal", "/work", environment, screenPorts(1, environment)),
        interactiveScreenCommand(false, "token", screenPorts(1, environment)),
        stopExtraScreenCommand(1, "bot's id", environment),
      ]) {
        const result = spawnSync("bash", ["-n", "-c", command], { encoding: "utf8" });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "skips damaged assignments while reserving their live display markers",
    () => {
      const f = fixture();
      writeFileSync(path.join(f.root, "empty.slot"), "");
      writeFileSync(path.join(f.root, "invalid.slot"), "broken\nlease:1\ntoken\n");
      writeFileSync(
        path.join(f.root, "browser-profile-20"),
        "/home/user/work/.browser-profiles/live",
      );
      expect(f.ensure("a").stdout).toContain("RAKAZO_DESKTOP=1:view-a");
      expect(f.ensure("b").stdout).toContain("RAKAZO_DESKTOP=2:view-b");
      expect(f.ensure("a").stdout).toContain("RAKAZO_DESKTOP=1:view-a");
    },
  );

  it.skipIf(process.platform !== "linux")(
    "continues resetting valid displays after invalid or out-of-range markers",
    () => {
      const f = fixture();
      for (const display of ["019", "19", "20", "22", "99999", "invalid"])
        writeFileSync(path.join(f.root, `browser-profile-${display}`), "fixture");
      const record = path.join(f.root, "stopped");
      const result = spawnSync(
        "bash",
        [
          "-eu",
          "-c",
          [
            "pkill() { :; }; sleep() { :; }",
            `bash() { printf '%s\\n' "$5" >>${shellQuote(record)}; }`,
            resetDesktopRuntimeCommand(env).replaceAll("/tmp/rakazo", f.root),
          ].join("\n"),
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(record, "utf8")).toBe("0\n2\n");
    },
  );

  it("stops only the selected VNC transport and keeps the shared gateway", () => {
    const command = stopExtraScreenCommand(1, "a", env);
    const patterns = [...command.matchAll(/pkill -f '([^']+)'/g)].map(
      (match) => new RegExp(match[1]!),
    );
    for (const pattern of patterns) {
      expect(`/bin/bash -c ${shellQuote(command)}`).not.toMatch(pattern);
      expect(
        "/usr/bin/python3 /usr/local/bin/websockify --web=/opt/noVNC 0.0.0.0:6100",
      ).not.toMatch(pattern);
    }
    expect(
      patterns.some((pattern) =>
        pattern.test(
          "/usr/bin/x11vnc -display :21 -rfbport 0 -unixsock /tmp/rakazo/sockets/view-21-token -forever",
        ),
      ),
    ).toBe(true);
  });

  it("uses one published gateway and distinct private ports across 1000 desktops", () => {
    const ports = new Set<number>();
    for (let index = 0; index < 1000; index++) {
      const layout = screenPorts(index, env);
      expect(layout.viewPort).toBe("6100");
      expect(layout.controlPort).toBe("6100");
      expect(ports.has(layout.debugPort)).toBe(false);
      ports.add(layout.debugPort);
    }
    expect(screenPorts(MAX_DESKTOP_DISPLAY - env.displayStart, env).debugPort).toBeLessThanOrEqual(
      65535,
    );
    for (const index of [-1, 0.5, Number.POSITIVE_INFINITY, MAX_DESKTOP_DISPLAY]) {
      expect(() => screenPorts(index, env)).toThrow("invalid desktop index");
    }
  });

  it.skipIf(process.platform !== "linux")(
    "quiesces the debugger-owning Chromium process and keeps cookie databases",
    () => {
      const root = mkdtempSync(path.join(tmpdir(), "desktop-quiesce-"));
      roots.push(root);
      const home = path.join(root, "home");
      const profiles = path.join(home, "team --type=renderer archive");
      const bin = path.join(root, "bin");
      const log = path.join(root, "closed");
      mkdirSync(bin);
      const sleeper = path.join(bin, "sleeper");
      writeFileSync(sleeper, "#!/usr/bin/env python3\nimport time\ntime.sleep(120)\n");
      chmodSync(sleeper, 0o755);
      writeFileSync(
        path.join(bin, "python3"),
        [
          "#!/bin/sh",
          'pid=""',
          'for arg in "$@"; do',
          '  case "$arg" in',
          "    ''|*[!0-9]*) ;;",
          "    *) pid=$arg ;;",
          "  esac",
          "done",
          'if [ -n "$pid" ]; then',
          '  printf "%s\\n" "$pid" >> "$QUIESCE_LOG"',
          '  kill "$pid" 2>/dev/null || true',
          "fi",
          "exit 0",
          "",
        ].join("\n"),
      );
      chmodSync(path.join(bin, "python3"), 0o755);
      const children: ChildProcess[] = [];
      const start = (directory: string, args: string[]) => {
        const cookies = path.join(directory, "Default", "Network", "Cookies");
        mkdirSync(path.dirname(cookies), { recursive: true });
        writeFileSync(cookies, "session=kept");
        const child = spawn(sleeper, args, {
          stdio: "ignore",
          detached: true,
        });
        children.push(child);
        return { child, cookies };
      };
      const botDir = path.join(profiles, "chromium-bot-abc");
      const primaryDir = path.join(profiles, "chromium");
      const python = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
        encoding: "utf8",
      }).stdout.trim();
      const joiner = path.join(bin, "join-cmdline.py");
      writeFileSync(joiner, JOINED_COMMAND);
      const joinedDir = path.join(profiles, "chromium-screen-4");
      const joinedReady = path.join(root, "joined-ready");
      const joinedCookies = path.join(joinedDir, "Default", "Network", "Cookies");
      mkdirSync(path.dirname(joinedCookies), { recursive: true });
      writeFileSync(joinedCookies, "session=kept");
      const joined = spawn(
        python,
        [joiner, `--user-data-dir=${joinedDir}`, "--remote-debugging-port=9335"],
        { stdio: "ignore", detached: true, env: { ...process.env, JOINED_READY: joinedReady } },
      );
      children.push(joined);
      const launcher = spawn(
        "/bin/sh",
        [
          "-c",
          "sleep 120",
          "launcher",
          `--user-data-dir=${botDir}`,
          "--remote-debugging-port=9333",
        ],
        { stdio: "ignore", detached: true },
      );
      children.push(launcher);
      const bot = start(botDir, [`--user-data-dir=${botDir}`, "--remote-debugging-port=9333"]);
      const botRenderer = start(botDir, [
        "--type=renderer",
        `--user-data-dir=${botDir}`,
        "--remote-debugging-port=9333",
      ]);
      const botHelper = start(botDir, [`--user-data-dir=${botDir}`]);
      const primary = start(primaryDir, [
        `--user-data-dir=${primaryDir}`,
        "--remote-debugging-port=9334",
      ]);
      try {
        const command = quiesceBrowserProfilesCommand({
          ...DEFAULT_DESKTOP_ENV,
          homeDir: home,
          workspaceDir: home,
          browserProfilesDir: profiles,
        }).replaceAll("/tmp/rakazo", path.join(root, "runtime"));
        waitForReady(joinedReady);
        const result = spawnSync("bash", ["-eu", "-c", command], {
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            QUIESCE_LOG: log,
          },
        });
        expect(result.status, result.stderr).toBe(0);
        const closed = readFileSync(log, "utf8").trim().split("\n");
        expect(closed).toEqual(
          expect.arrayContaining([
            String(bot.child.pid),
            String(primary.child.pid),
            String(joined.pid),
          ]),
        );
        expect(closed).not.toContain(String(botRenderer.child.pid));
        expect(closed).not.toContain(String(botHelper.child.pid));
        expect(closed).not.toContain(String(launcher.pid));
        expect(spawnSync("kill", ["-0", String(botRenderer.child.pid)]).status).toBe(0);
        expect(spawnSync("kill", ["-0", String(botHelper.child.pid)]).status).toBe(0);
        expect(readFileSync(bot.cookies, "utf8")).toBe("session=kept");
        expect(readFileSync(primary.cookies, "utf8")).toBe("session=kept");
        expect(readFileSync(joinedCookies, "utf8")).toBe("session=kept");
      } finally {
        for (const child of children) {
          if (!child.pid) continue;
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
    },
  );

  it.skipIf(process.platform !== "linux").each(["replacement", "unclosed"])(
    "preserves lock state and fails when a %s browser survives shutdown",
    (mode) => {
      const root = mkdtempSync(path.join(tmpdir(), "desktop-stop-"));
      roots.push(root);
      const profile = path.join(root, "profile with spaces");
      const pidFile = path.join(root, "browser-pid");
      const replacementPidFile = path.join(root, "replacement-pid");
      const ready = path.join(root, "ready");
      const sleeper = path.join(root, "browser.py");
      const python = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
        encoding: "utf8",
      }).stdout.trim();
      mkdirSync(profile);
      const locks = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
      for (const lock of locks) writeFileSync(path.join(profile, lock), "keep");
      writeFileSync(
        sleeper,
        `import time\nopen(${JSON.stringify(ready)}, "w").write("ready")\ntime.sleep(120)\n`,
      );
      const child = spawn(
        python,
        [sleeper, `--user-data-dir=${profile}`, "--remote-debugging-port=9336"],
        { stdio: "ignore", detached: true },
      );
      try {
        waitForReady(ready);
        writeFileSync(pidFile, String(child.pid));
        const close =
          mode === "replacement"
            ? [
                "python3() {",
                `  rm -f ${shellQuote(ready)}`,
                `  ${shellQuote(python)} ${shellQuote(sleeper)} ${shellQuote(`--user-data-dir=${profile}`)} --remote-debugging-port=9337 </dev/null >/dev/null 2>&1 &`,
                `  printf %s "$!" >${shellQuote(replacementPidFile)}`,
                `  for attempt in $(seq 1 100); do [ -s ${shellQuote(ready)} ] && break; sleep 0.01; done`,
                `  [ -s ${shellQuote(ready)} ] || return 1`,
                '  kill "$3"',
                "}",
              ].join("\n")
            : "python3() { return 1; }; kill() { return 0; }; sleep() { :; }";
        const result = spawnSync(
          "bash",
          ["-eu", "-c", `${close}\n${stopBrowserProfileCommand(profile, shellQuote(pidFile))}`],
          { encoding: "utf8", timeout: 20_000 },
        );
        expect(result.status, result.stderr).toBe(BROWSER_STILL_RUNNING_EXIT);
        expect(result.stderr).toContain("browser still running");
        for (const lock of locks) {
          expect(readFileSync(path.join(profile, lock), "utf8")).toBe("keep");
        }
        expect(readFileSync(pidFile, "utf8")).not.toBe("");
        const survivingPid =
          mode === "replacement" ? Number(readFileSync(replacementPidFile, "utf8")) : child.pid;
        expect(survivingPid).toBeGreaterThan(0);
        if (!survivingPid) throw new Error("expected surviving browser PID");
        expect(() => process.kill(survivingPid, 0)).not.toThrow();
      } finally {
        child.kill("SIGKILL");
        try {
          const pid = Number(readFileSync(replacementPidFile, "utf8"));
          if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
        } catch {
          // The close command may fail before starting a replacement.
        }
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "starts the screen browser again when the one it found exits before its port answers",
    () => {
      const root = mkdtempSync(path.join(tmpdir(), "desktop-ensure-"));
      roots.push(root);
      const bin = path.join(root, "bin");
      const launches = path.join(root, "launches");
      const ready = path.join(root, "ready");
      mkdirSync(bin);
      const screenEnv = {
        ...env,
        browserProfilesDir: path.join(root, "profiles"),
        displayStart: 31_000,
        preservePrimaryDisplay: true,
      };
      const { debugPort } = screenPorts(0, screenEnv);
      writeFileSync(
        path.join(bin, "rakazo-browser"),
        [
          "#!/usr/bin/env python3",
          "import os, socket, sys, time",
          `open(${JSON.stringify(launches)}, "a").write("launch\\n")`,
          "server = socket.socket()",
          "server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
          `server.bind(("127.0.0.1", ${debugPort}))`,
          "server.listen()",
          "time.sleep(60)",
          "",
        ].join("\n"),
      );
      chmodSync(path.join(bin, "rakazo-browser"), 0o755);
      const command = ensureScreenCommand(0, "bot", "token", screenEnv)
        .replaceAll("/tmp/rakazo", path.join(root, "runtime"))
        .replaceAll("/usr/share/novnc", root);
      const cdpChecked = command.indexOf("\nfi\n", command.indexOf("CDP not ready")) + 4;
      const profile = browserProfilePathForScreen("bot", screenEnv);
      mkdirSync(profile, { recursive: true });
      const closing = spawn(
        "python3",
        [
          "-c",
          'import os, time; open(os.environ["READY"], "w").write("ready"); time.sleep(1.5)',
          `--user-data-dir=${profile}`,
          `--remote-debugging-port=${debugPort}`,
        ],
        { stdio: "ignore", detached: true, env: { ...process.env, READY: ready } },
      );
      try {
        waitForReady(ready);
        const result = spawnSync(
          "bash",
          [
            "-eu",
            "-c",
            [
              "xdpyinfo() { return 0; }",
              "command() { return 0; }",
              command.slice(0, cdpChecked),
              "echo cdp-ready",
            ].join("\n"),
          ],
          {
            encoding: "utf8",
            timeout: 20_000,
            env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
          },
        );
        expect(result.stdout, result.stderr).toContain("cdp-ready");
        expect(readFileSync(launches, "utf8")).toBe("launch\n");
      } finally {
        closing.kill("SIGKILL");
        const browser = Number(
          readFileSync(
            path.join(
              root,
              "runtime",
              `browser-pid-${createHash("sha256").update("bot").digest("hex").slice(0, 32)}`,
            ),
            "utf8",
          ),
        );
        if (Number.isSafeInteger(browser) && browser > 0) process.kill(browser, "SIGKILL");
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "reads the debugging port from a space-joined Chromium command line",
    () => {
      const root = mkdtempSync(path.join(tmpdir(), "desktop-port-"));
      roots.push(root);
      const ready = path.join(root, "ready");
      const python = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
        encoding: "utf8",
      }).stdout.trim();
      const joiner = path.join(root, "join-cmdline.py");
      writeFileSync(joiner, JOINED_COMMAND);
      const child = spawn(
        python,
        [
          joiner,
          "--user-data-dir=/tmp/my --type=renderer --remote-debugging-port=1 profile",
          "--remote-debugging-port=9444",
        ],
        { stdio: "ignore", detached: true, env: { ...process.env, JOINED_READY: ready } },
      );
      try {
        waitForReady(ready);
        const result = spawnSync(
          python,
          [
            "-c",
            browserCloseProgram(),
            String(child.pid),
            "/tmp/my --type=renderer --remote-debugging-port=1 profile",
            "--print-port",
          ],
          {
            encoding: "utf8",
            timeout: 5_000,
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe("9444");
      } finally {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
    },
  );

  it("keeps provider authentication while adding the per-lease websocket capability", () => {
    const url = new URL(
      desktopUrl("https://desktop.test/vnc.html?_token=provider-key", "view-key"),
    );
    expect(url.searchParams.get("_token")).toBe("provider-key");
    expect(url.searchParams.get("path")).toBe("websockify?_token=provider-key&token=view-key");
  });

  function recordedPid(contents: string) {
    return contents.trim().split(/\s+/)[0] ?? "";
  }

  function procStartTime(pid: string) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/);
      return fields[19] ?? "";
    } catch {
      return "";
    }
  }

  async function portalScreenFixture() {
    const root = mkdtempSync(path.join(tmpdir(), "desktop-portal-"));
    roots.push(root);
    const bin = path.join(root, "bin");
    const libexec = path.join(root, "libexec");
    const runtime = path.join(root, "rt");
    const recordBin = path.join(root, "record-bin");
    const browserLog = path.join(root, "browser-log");
    const portalLog = path.join(root, "portal-log");
    const dbusLog = path.join(root, "dbus-log");
    const activationLog = path.join(root, "activation-log");
    const dbusSendLog = path.join(root, "dbus-send-log");
    const pidLog = path.join(root, "pid-log");
    const recorderLog = path.join(root, "recorder-log");
    mkdirSync(runtime);
    const gateway = net.createServer();
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const gatewayAddress = gateway.address();
    if (!gatewayAddress || typeof gatewayAddress === "string") {
      throw new Error("expected gateway port");
    }
    const port = gatewayAddress.port;
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    const screenEnv = {
      homeDir: path.join(root, "home"),
      workspaceDir: path.join(root, "work"),
      browserProfilesDir: path.join(root, "profiles"),
      displayStart: 80,
      portStart: port,
      preservePrimaryDisplay: true,
      bindHost: "127.0.0.1",
    };
    const writeExecutable = (file: string, contents: string) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, contents);
      chmodSync(file, 0o755);
    };
    const python = spawnSync(
      "python3",
      ["-c", "import os, sys; print(os.path.realpath(sys.executable))"],
      { encoding: "utf8" },
    );
    if (python.status !== 0) throw new Error(python.stderr);
    const siteDir = path.join(root, "py");
    mkdirSync(siteDir);
    writeFileSync(
      path.join(siteDir, "sitecustomize.py"),
      [
        "import os, time",
        "name = os.path.basename(os.readlink('/proc/self/exe'))",
        "if name.startswith('xdg-desktop-portal') or name == 'dbus-daemon':",
        "    pid_log = os.environ.get('PID_LOG')",
        "    if pid_log:",
        "        handle = open(pid_log, 'a')",
        "        handle.write('%s\\n' % os.getpid())",
        "        handle.close()",
        "    portal_log = os.environ.get('PORTAL_LOG')",
        "    if portal_log and name.startswith('xdg-desktop-portal'):",
        "        display = os.environ.get('DISPLAY', '')",
        "        bus = os.environ.get('DBUS_SESSION_BUS_ADDRESS', '')",
        "        handle = open(portal_log, 'a')",
        "        handle.write('%s DISPLAY=%s DBUS=%s\\n' % (name, display, bus))",
        "        handle.close()",
        "    while True:",
        "        time.sleep(3600)",
        "",
      ].join("\n"),
    );
    mkdirSync(bin, { recursive: true });
    mkdirSync(libexec, { recursive: true });
    const hold = (file: string) => {
      copyFileSync(python.stdout.trim(), file);
      chmodSync(file, 0o755);
    };
    hold(path.join(bin, "dbus-daemon"));
    hold(path.join(libexec, "xdg-desktop-portal"));
    hold(path.join(libexec, "xdg-desktop-portal-gtk"));
    writeExecutable(
      path.join(bin, "dbus-launch"),
      [
        "#!/bin/bash",
        "printf 'launch\\n' >> \"$DBUS_LOG\"",
        "daemon=$(command -v dbus-daemon) || exit 1",
        '"$daemon" </dev/null >/dev/null 2>&1 &',
        "pid=$!",
        'printf "DBUS_SESSION_BUS_ADDRESS=\'unix:path=%s/bus-%s\';\\n" "$RUNTIME" "$pid"',
        "printf 'export DBUS_SESSION_BUS_ADDRESS;\\n'",
        "printf 'DBUS_SESSION_BUS_PID=%s;\\n' \"$pid\"",
        "printf 'export DBUS_SESSION_BUS_PID;\\n'",
        "",
      ].join("\n"),
    );
    writeExecutable(
      path.join(bin, "dbus-update-activation-environment"),
      [
        "#!/bin/bash",
        'printf \'bus=%s args=%s\\n\' "$DBUS_SESSION_BUS_ADDRESS" "$*" >> "$ACTIVATION_LOG"',
        "",
      ].join("\n"),
    );
    writeExecutable(
      path.join(bin, "dbus-send"),
      [
        "#!/bin/bash",
        'if [ -n "$DBUS_SEND_LOG" ]; then printf \'%s\\n\' "$*" >> "$DBUS_SEND_LOG"; fi',
        "printf 'boolean true\\n'",
        "",
      ].join("\n"),
    );
    writeExecutable(
      path.join(bin, "rakazo-browser"),
      [
        "#!/usr/bin/env python3",
        "import os, socket, sys, time",
        "log = os.environ.get('BROWSER_LOG')",
        "if log:",
        "    handle = open(log, 'a')",
        "    handle.write('DISPLAY=%s\\nDBUS=%s\\n' % (os.environ.get('DISPLAY', ''), os.environ.get('DBUS_SESSION_BUS_ADDRESS', '')))",
        "    handle.flush()",
        "    handle.close()",
        "pid_log = os.environ.get('PID_LOG')",
        "if pid_log:",
        "    open(pid_log, 'a').write(str(os.getpid()) + '\\n')",
        "port = None",
        "for arg in sys.argv[1:]:",
        "    if arg.startswith('--remote-debugging-port='):",
        "        port = int(arg.split('=', 1)[1])",
        "if port is None:",
        "    raise SystemExit('missing debugging port')",
        "server = socket.socket()",
        "server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
        "server.bind(('127.0.0.1', port))",
        "server.listen()",
        "while True:",
        "    connection, _addr = server.accept()",
        "    connection.settimeout(0.2)",
        "    try:",
        "        request = connection.recv(1024)",
        "    except socket.timeout:",
        "        request = b''",
        "    connection.close()",
        "    if b'GET /json/version' in request:",
        "        break",
        "",
      ].join("\n"),
    );
    writeExecutable(
      path.join(bin, "x11vnc"),
      [
        "#!/usr/bin/env python3",
        "import os, socket, sys, time",
        "pid_log = os.environ.get('PID_LOG')",
        "if pid_log:",
        "    open(pid_log, 'a').write(str(os.getpid()) + '\\n')",
        "sock = None",
        "args = sys.argv[1:]",
        "for index, arg in enumerate(args):",
        "    if arg == '-unixsock' and index + 1 < len(args):",
        "        sock = args[index + 1]",
        "if not sock:",
        "    raise SystemExit('missing socket')",
        "os.makedirs(os.path.dirname(sock), exist_ok=True)",
        "try:",
        "    os.remove(sock)",
        "except FileNotFoundError:",
        "    pass",
        "server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
        "server.bind(sock)",
        "server.listen()",
        "time.sleep(300)",
        "",
      ].join("\n"),
    );
    writeExecutable(
      path.join(bin, "websockify"),
      [
        "#!/usr/bin/env python3",
        "import os, socket, sys, time",
        "pid_log = os.environ.get('PID_LOG')",
        "if pid_log:",
        "    open(pid_log, 'a').write(str(os.getpid()) + '\\n')",
        "port = None",
        "for arg in sys.argv[1:]:",
        "    if arg.startswith('127.0.0.1:'):",
        "        port = int(arg.split(':')[1])",
        "if port is None:",
        "    raise SystemExit('missing port')",
        "server = socket.socket()",
        "server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
        "server.bind(('127.0.0.1', port))",
        "server.listen()",
        "time.sleep(300)",
        "",
      ].join("\n"),
    );
    writeExecutable(
      path.join(recordBin, "rakazo-browser"),
      [
        "#!/usr/bin/env python3",
        "import os",
        "handle = open(os.environ['RECORDER_LOG'], 'a')",
        "handle.write('DISPLAY=%s\\nDBUS=%s\\n' % (os.environ.get('DISPLAY', ''), os.environ.get('DBUS_SESSION_BUS_ADDRESS', '')))",
        "handle.close()",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(runtime, "dbus-session"),
      "export DBUS_SESSION_BUS_ADDRESS=unix:path=/boot-bus\n",
    );
    const runEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      BROWSER_LOG: browserLog,
      PORTAL_LOG: portalLog,
      DBUS_LOG: dbusLog,
      PID_LOG: pidLog,
      RUNTIME: runtime,
      PYTHONPATH: siteDir,
      DISPLAY: ":1",
      ACTIVATION_LOG: activationLog,
      DBUS_SEND_LOG: dbusSendLog,
    };
    delete runEnv.DBUS_SESSION_BUS_ADDRESS;
    const relocate = (script: string) =>
      script
        .replaceAll("/usr/libexec", libexec)
        .replaceAll("/tmp/rakazo", runtime)
        .replaceAll("/usr/share/novnc", root)
        .replaceAll("/tmp/fluxbox-home-", path.join(root, "flux-"));
    const run = (script: string, displayUp: boolean) =>
      spawnSync(
        "bash",
        ["-eu", "-c", `${displayUp ? "xdpyinfo() { return 0; }\n" : ""}${script}`],
        { encoding: "utf8", timeout: 40_000, env: runEnv },
      );
    const busAddress = (file: string) => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.DBUS_SESSION_BUS_ADDRESS;
      return spawnSync(
        "bash",
        [
          "-c",
          'unset DBUS_SESSION_BUS_ADDRESS; . "$1"; printf %s "$DBUS_SESSION_BUS_ADDRESS"',
          "bash",
          file,
        ],
        { encoding: "utf8", env },
      ).stdout;
    };
    const alive = (pid: string) => {
      const parsed = Number(pid);
      if (!Number.isSafeInteger(parsed) || parsed <= 1) return false;
      try {
        process.kill(parsed, 0);
        return true;
      } catch {
        return false;
      }
    };
    const launch = (display: number, inherited: string | undefined, log: string) => {
      const env: NodeJS.ProcessEnv = {
        PATH: `${recordBin}${path.delimiter}${process.env.PATH ?? ""}`,
        HOME: screenEnv.homeDir,
        RECORDER_LOG: log,
      };
      if (inherited !== undefined) env.DBUS_SESSION_BUS_ADDRESS = inherited;
      return spawnSync(path.join(runtime, `browser-launch-${display}`), [], {
        encoding: "utf8",
        timeout: 5_000,
        env,
      });
    };
    const extraDisplay = screenEnv.displayStart + 1;
    const bootDisplay = screenEnv.displayStart;
    const cleanup = () => {
      if (!existsSync(pidLog)) return;
      for (const line of readFileSync(pidLog, "utf8").split("\n")) {
        const parsed = Number(line);
        if (!Number.isSafeInteger(parsed) || parsed <= 1) continue;
        try {
          process.kill(parsed, "SIGKILL");
        } catch {
          // The screen stop already reaped it.
        }
      }
    };
    return {
      root,
      runtime,
      bin,
      libexec,
      pidLog,
      pythonBin: python.stdout.trim(),
      runEnv,
      browserLog,
      portalLog,
      dbusLog,
      activationLog,
      recorderLog,
      screenEnv,
      run,
      relocate,
      busAddress,
      alive,
      launch,
      extraDisplay,
      bootDisplay,
      cleanup,
    };
  }

  it.skipIf(process.platform !== "linux")(
    "team-screen-file-chooser-portal",
    async () => {
      const {
        root,
        runtime,
        browserLog,
        portalLog,
        dbusLog,
        recorderLog,
        screenEnv,
        run,
        relocate,
        busAddress,
        alive,
        launch,
        extraDisplay,
        bootDisplay,
        cleanup,
      } = await portalScreenFixture();
      try {
        const extra = relocate(ensureScreenCommand(1, "extra", "viewtok", screenEnv));
        const first = run(extra, true);
        expect(first.status, first.stderr).toBe(0);
        const busFile = path.join(runtime, `dbus-session-${extraDisplay}`);
        const address = busAddress(busFile);
        expect(address.startsWith("unix:path=")).toBe(true);
        expect(address).not.toBe("unix:path=/boot-bus");
        const expectedPortals = [
          `xdg-desktop-portal DISPLAY=:${extraDisplay} DBUS=${address}`,
          `xdg-desktop-portal-gtk DISPLAY=:${extraDisplay} DBUS=${address}`,
        ].sort();
        const portalLines = () =>
          readFileSync(portalLog, "utf8")
            .trim()
            .split("\n")
            .filter((line) => line.length > 0)
            .sort();
        expect(portalLines()).toEqual(expectedPortals);
        expect(readFileSync(browserLog, "utf8")).toBe(
          `DISPLAY=:${extraDisplay}\nDBUS=${address}\n`,
        );
        expect(readFileSync(dbusLog, "utf8")).toBe("launch\n");
        const dbusPid = readFileSync(path.join(runtime, `dbus-pid-${extraDisplay}`), "utf8");
        const portalPid = readFileSync(path.join(runtime, `portal-pid-${extraDisplay}`), "utf8");
        const gtkPid = readFileSync(path.join(runtime, `portal-gtk-pid-${extraDisplay}`), "utf8");
        expect(alive(recordedPid(dbusPid))).toBe(true);
        expect(alive(recordedPid(portalPid))).toBe(true);
        expect(alive(recordedPid(gtkPid))).toBe(true);

        const second = run(extra, true);
        expect(second.status, second.stderr).toBe(0);
        expect(readFileSync(dbusLog, "utf8")).toBe("launch\n");
        expect(portalLines()).toEqual(expectedPortals);
        expect(readFileSync(browserLog, "utf8")).toBe(
          `DISPLAY=:${extraDisplay}\nDBUS=${address}\n`,
        );
        expect(readFileSync(path.join(runtime, `dbus-pid-${extraDisplay}`), "utf8")).toBe(dbusPid);
        expect(readFileSync(path.join(runtime, `portal-pid-${extraDisplay}`), "utf8")).toBe(
          portalPid,
        );
        expect(readFileSync(path.join(runtime, `portal-gtk-pid-${extraDisplay}`), "utf8")).toBe(
          gtkPid,
        );

        const inherited = launch(extraDisplay, "unix:path=/boot-bus", recorderLog);
        expect(inherited.status, inherited.stderr).toBe(0);
        expect(readFileSync(recorderLog, "utf8")).toBe(
          `DISPLAY=:${extraDisplay}\nDBUS=${address}\n`,
        );

        const boot = run(relocate(ensureScreenCommand(0, "boot", "viewboot", screenEnv)), true);
        expect(boot.status, boot.stderr).toBe(0);
        expect(readFileSync(dbusLog, "utf8")).toBe("launch\n");
        expect(portalLines()).toEqual(expectedPortals);
        expect(readFileSync(browserLog, "utf8")).toBe(
          `DISPLAY=:${extraDisplay}\nDBUS=${address}\nDISPLAY=:${bootDisplay}\nDBUS=unix:path=/boot-bus\n`,
        );
        const sourced = launch(bootDisplay, undefined, path.join(root, "boot-recorder"));
        expect(sourced.status, sourced.stderr).toBe(0);
        expect(readFileSync(path.join(root, "boot-recorder"), "utf8")).toBe(
          `DISPLAY=:${bootDisplay}\nDBUS=unix:path=/boot-bus\n`,
        );
        const kept = launch(bootDisplay, "unix:path=/already-set", path.join(root, "boot-kept"));
        expect(kept.status, kept.stderr).toBe(0);
        expect(readFileSync(path.join(root, "boot-kept"), "utf8")).toBe(
          `DISPLAY=:${bootDisplay}\nDBUS=unix:path=/already-set\n`,
        );

        const stopped = run(relocate(stopExtraScreenCommand(1, "extra", screenEnv)), false);
        expect(stopped.status, stopped.stderr).toBe(0);
        expect(existsSync(busFile)).toBe(false);
        expect(existsSync(path.join(runtime, `dbus-pid-${extraDisplay}`))).toBe(false);
        expect(existsSync(path.join(runtime, `portal-pid-${extraDisplay}`))).toBe(false);
        expect(existsSync(path.join(runtime, `portal-gtk-pid-${extraDisplay}`))).toBe(false);
        expect(readFileSync(path.join(runtime, "dbus-session"), "utf8")).toBe(
          "export DBUS_SESSION_BUS_ADDRESS=unix:path=/boot-bus\n",
        );
        expect(alive(recordedPid(dbusPid))).toBe(false);
        expect(alive(recordedPid(portalPid))).toBe(false);
        expect(alive(recordedPid(gtkPid))).toBe(false);
        const bootHash = createHash("sha256").update("boot").digest("hex").slice(0, 32);
        const bootPid = readFileSync(path.join(runtime, `browser-pid-${bootHash}`), "utf8");
        expect(alive(bootPid)).toBe(true);

        const restarted = run(extra, true);
        expect(restarted.status, restarted.stderr).toBe(0);
        const restartedPortal = readFileSync(
          path.join(runtime, `portal-pid-${extraDisplay}`),
          "utf8",
        );
        const restartedGtk = readFileSync(
          path.join(runtime, `portal-gtk-pid-${extraDisplay}`),
          "utf8",
        );
        const restartedBus = readFileSync(path.join(runtime, `dbus-pid-${extraDisplay}`), "utf8");
        expect(alive(recordedPid(restartedPortal))).toBe(true);
        const reset = run(relocate(resetDesktopRuntimeCommand(screenEnv)), false);
        expect(reset.status, reset.stderr).toBe(0);
        expect(existsSync(busFile)).toBe(false);
        expect(existsSync(path.join(runtime, `dbus-pid-${extraDisplay}`))).toBe(false);
        expect(readFileSync(path.join(runtime, "dbus-session"), "utf8")).toBe(
          "export DBUS_SESSION_BUS_ADDRESS=unix:path=/boot-bus\n",
        );
        expect(alive(recordedPid(restartedPortal))).toBe(false);
        expect(alive(recordedPid(restartedGtk))).toBe(false);
        expect(alive(recordedPid(restartedBus))).toBe(false);
      } finally {
        cleanup();
      }
    },
    60_000,
  );

  it.skipIf(process.platform !== "linux")(
    "recycled screen session pids are left alive",
    async () => {
      const { runtime, screenEnv, run, relocate, alive, extraDisplay, dbusLog, cleanup } =
        await portalScreenFixture();
      const unrelated = String(process.pid);
      const dbusPid = path.join(runtime, `dbus-pid-${extraDisplay}`);
      const portalPid = path.join(runtime, `portal-pid-${extraDisplay}`);
      const gtkPid = path.join(runtime, `portal-gtk-pid-${extraDisplay}`);
      const busFile = path.join(runtime, `dbus-session-${extraDisplay}`);
      const plant = () => {
        writeFileSync(dbusPid, unrelated);
        writeFileSync(portalPid, unrelated);
        writeFileSync(gtkPid, unrelated);
        writeFileSync(busFile, "export DBUS_SESSION_BUS_ADDRESS=unix:path=/stale\n");
      };
      try {
        plant();
        const stopped = run(relocate(stopExtraScreenCommand(1, "extra", screenEnv)), false);
        expect(stopped.status, stopped.stderr).toBe(0);
        expect(alive(unrelated)).toBe(true);
        expect(existsSync(dbusPid)).toBe(false);
        expect(existsSync(portalPid)).toBe(false);
        expect(existsSync(gtkPid)).toBe(false);

        plant();
        writeFileSync(path.join(runtime, `browser-profile-${extraDisplay}`), "profile");
        const reset = run(relocate(resetDesktopRuntimeCommand(screenEnv)), false);
        expect(reset.status, reset.stderr).toBe(0);
        expect(alive(unrelated)).toBe(true);
        expect(existsSync(dbusPid)).toBe(false);

        plant();
        const ensured = run(relocate(ensureScreenCommand(1, "extra", "viewtok", screenEnv)), true);
        expect(ensured.status, ensured.stderr).toBe(0);
        expect(alive(unrelated)).toBe(true);
        expect(readFileSync(dbusLog, "utf8")).toBe("launch\n");
        expect(readFileSync(dbusPid, "utf8")).not.toBe(unrelated);
        expect(alive(recordedPid(readFileSync(dbusPid, "utf8")))).toBe(true);
      } finally {
        cleanup();
      }
    },
    60_000,
  );

  it.skipIf(process.platform !== "linux")(
    "restarts only a dead screen portal",
    async () => {
      const {
        runtime,
        screenEnv,
        run,
        relocate,
        alive,
        extraDisplay,
        dbusLog,
        portalLog,
        cleanup,
      } = await portalScreenFixture();
      const command = relocate(ensureScreenCommand(1, "extra", "viewtok", screenEnv));
      const dbusPid = path.join(runtime, `dbus-pid-${extraDisplay}`);
      const portalPid = path.join(runtime, `portal-pid-${extraDisplay}`);
      const gtkPid = path.join(runtime, `portal-gtk-pid-${extraDisplay}`);
      const waitDead = async (pid: string) => {
        for (let i = 0; i < 50 && alive(pid); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(alive(pid)).toBe(false);
      };
      try {
        const first = run(command, true);
        expect(first.status, first.stderr).toBe(0);
        const gtk = readFileSync(gtkPid, "utf8");
        const portal = readFileSync(portalPid, "utf8");
        const dbus = readFileSync(dbusPid, "utf8");
        process.kill(Number(recordedPid(gtk)), "SIGKILL");
        await waitDead(recordedPid(gtk));
        const second = run(command, true);
        expect(second.status, second.stderr).toBe(0);
        expect(readFileSync(dbusLog, "utf8")).toBe("launch\n");
        expect(readFileSync(dbusPid, "utf8")).toBe(dbus);
        expect(readFileSync(portalPid, "utf8")).toBe(portal);
        expect(readFileSync(gtkPid, "utf8")).not.toBe(gtk);
        expect(alive(recordedPid(readFileSync(gtkPid, "utf8")))).toBe(true);
        expect(alive(recordedPid(portal))).toBe(true);
        expect(alive(recordedPid(dbus))).toBe(true);
        const lines = readFileSync(portalLog, "utf8").trim().split("\n");
        expect(lines.filter((line) => line.startsWith("xdg-desktop-portal "))).toHaveLength(1);
        expect(lines.filter((line) => line.startsWith("xdg-desktop-portal-gtk "))).toHaveLength(2);
      } finally {
        cleanup();
      }
    },
    60_000,
  );

  it.skipIf(process.platform !== "linux")(
    "waits for a file chooser that is slow to exec",
    async () => {
      const { runtime, bin, screenEnv, run, relocate, alive, extraDisplay, cleanup } =
        await portalScreenFixture();
      // Holds the forked pid on nohup's own executable before it execs the portal.
      writeFileSync(path.join(bin, "nohup"), '#!/bin/bash\nsleep 0.3\nexec "$@"\n');
      chmodSync(path.join(bin, "nohup"), 0o755);
      try {
        const result = run(relocate(ensureScreenCommand(1, "extra", "viewtok", screenEnv)), true);
        expect(result.status, result.stderr).toBe(0);
        const gtk = readFileSync(path.join(runtime, `portal-gtk-pid-${extraDisplay}`), "utf8");
        expect(alive(recordedPid(gtk))).toBe(true);
      } finally {
        // Let both portals finish exec and log their pids so cleanup can stop them.
        await new Promise((resolve) => setTimeout(resolve, 500));
        cleanup();
      }
    },
    60_000,
  );

  it.skipIf(process.platform !== "linux")(
    "accepts a file chooser that execs between process checks",
    async () => {
      const { bin, libexec, screenEnv, run, relocate, cleanup } = await portalScreenFixture();
      // The first executable read sees nohup; the next sees the portal after exec.
      writeFileSync(
        path.join(bin, "readlink"),
        [
          "#!/bin/bash",
          'target=$(/usr/bin/readlink "$@") || exit 1',
          'case "$1" in',
          "  /proc/*/exe)",
          '    proc_dir=$(dirname "$1")',
          `    if [ ! -f "$0.seen" ] && tr '\\0' '\\n' < "$proc_dir/cmdline" 2>/dev/null | grep -Fx -- ${shellQuote(path.join(libexec, "xdg-desktop-portal-gtk"))} >/dev/null; then`,
          "      for i in $(seq 1 100); do",
          '        target=$(/usr/bin/readlink "$@") || exit 1',
          '        case "$target" in */xdg-desktop-portal-gtk) break ;; esac',
          "        sleep 0.01",
          "      done",
          '      case "$target" in */xdg-desktop-portal-gtk) ;; *) exit 1 ;; esac',
          '      touch "$0.seen"',
          "      printf '/usr/bin/nohup\\n'",
          "      exit 0",
          "    fi ;;",
          "esac",
          `printf '%s\\n' "$target"`,
          "",
        ].join("\n"),
      );
      chmodSync(path.join(bin, "readlink"), 0o755);
      try {
        const result = run(relocate(ensureScreenCommand(1, "extra", "viewtok", screenEnv)), true);
        expect(existsSync(path.join(bin, "readlink.seen"))).toBe(true);
        expect(result.status, result.stderr).toBe(0);
      } finally {
        cleanup();
      }
    },
    60_000,
  );

  it.skipIf(process.platform !== "linux")(
    "restarts a dead screen bus without killing an unrelated pid",
    async () => {
      const { runtime, screenEnv, run, relocate, alive, extraDisplay, dbusLog, cleanup } =
        await portalScreenFixture();
      const command = relocate(ensureScreenCommand(1, "extra", "viewtok", screenEnv));
      const dbusPid = path.join(runtime, `dbus-pid-${extraDisplay}`);
      const portalPid = path.join(runtime, `portal-pid-${extraDisplay}`);
      const gtkPid = path.join(runtime, `portal-gtk-pid-${extraDisplay}`);
      const waitDead = async (pid: string) => {
        for (let i = 0; i < 50 && alive(pid); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(alive(pid)).toBe(false);
      };
      try {
        const first = run(command, true);
        expect(first.status, first.stderr).toBe(0);
        const dbus = readFileSync(dbusPid, "utf8");
        const portal = readFileSync(portalPid, "utf8");
        const gtk = readFileSync(gtkPid, "utf8");
        process.kill(Number(recordedPid(dbus)), "SIGKILL");
        await waitDead(recordedPid(dbus));
        const unrelated = String(process.pid);
        writeFileSync(dbusPid, unrelated);
        writeFileSync(portalPid, unrelated);
        const second = run(command, true);
        expect(second.status, second.stderr).toBe(0);
        expect(alive(unrelated)).toBe(true);
        expect(alive(recordedPid(portal))).toBe(true);
        expect(alive(recordedPid(gtk))).toBe(false);
        expect(readFileSync(dbusLog, "utf8")).toBe("launch\nlaunch\n");
        const restartedBus = readFileSync(dbusPid, "utf8");
        const restartedPortal = readFileSync(portalPid, "utf8");
        const restartedGtk = readFileSync(gtkPid, "utf8");
        expect(restartedBus).not.toBe(unrelated);
        expect(restartedPortal).not.toBe(unrelated);
        expect(restartedGtk).not.toBe(unrelated);
        expect(alive(recordedPid(restartedBus))).toBe(true);
        expect(alive(recordedPid(restartedPortal))).toBe(true);
        expect(alive(recordedPid(restartedGtk))).toBe(true);
      } finally {
        cleanup();
      }
    },
    60_000,
  );

  it("screen bus activation uses that screen's display", async () => {
    const script = ensureScreenCommand(1, "extra", "viewtok");
    const launchAt = script.indexOf("DISPLAY=:2 dbus-launch --sh-syntax");
    const activationAt = script.indexOf("dbus-update-activation-environment DISPLAY=:2");
    const claimAt = script.indexOf("screen_claim_gtk", activationAt);
    const portalAt = script.indexOf("nohup /usr/libexec/xdg-desktop-portal ", activationAt);
    expect(launchAt).toBeGreaterThan(-1);
    expect(activationAt).toBeGreaterThan(launchAt);
    expect(claimAt).toBeGreaterThan(activationAt);
    expect(portalAt).toBeGreaterThan(claimAt);
    expect(script).toContain("org.freedesktop.DBus.NameHasOwner");
    expect(script).toContain("string:org.freedesktop.impl.portal.desktop.gtk");
    expect(ensureScreenCommand(0, "boot", "viewtok")).not.toContain(
      "dbus-update-activation-environment",
    );
    const managed = managedDesktopCommand("bot", "run:1", DEFAULT_DESKTOP_ENV, "token");
    expect(managed).toContain(`DISPLAY=:\${desktop_display} dbus-launch --sh-syntax`);
    expect(managed).toContain(`dbus-update-activation-environment DISPLAY=:\${desktop_display}`);
    if (process.platform !== "linux") return;

    const {
      runtime,
      screenEnv,
      run,
      relocate,
      alive,
      extraDisplay,
      busAddress,
      activationLog,
      cleanup,
    } = await portalScreenFixture();
    try {
      const ensured = run(relocate(ensureScreenCommand(1, "extra", "viewtok", screenEnv)), true);
      expect(ensured.status, ensured.stderr).toBe(0);
      const address = busAddress(path.join(runtime, `dbus-session-${extraDisplay}`));
      expect(readFileSync(activationLog, "utf8")).toBe(
        `bus=${address} args=DISPLAY=:${extraDisplay}\n`,
      );
      const gtkPid = recordedPid(
        readFileSync(path.join(runtime, `portal-gtk-pid-${extraDisplay}`), "utf8"),
      );
      expect(alive(gtkPid)).toBe(true);
      const gtkEnviron = readFileSync(`/proc/${gtkPid}/environ`).toString("utf8").split("\0");
      expect(gtkEnviron).toContain(`DISPLAY=:${extraDisplay}`);
      expect(gtkEnviron).not.toContain("DISPLAY=:1");
      const dbusPid = recordedPid(
        readFileSync(path.join(runtime, `dbus-pid-${extraDisplay}`), "utf8"),
      );
      const daemonEnviron = readFileSync(`/proc/${dbusPid}/environ`).toString("utf8").split("\0");
      expect(daemonEnviron).toContain(`DISPLAY=:${extraDisplay}`);
      expect(daemonEnviron).not.toContain("DISPLAY=:1");
    } finally {
      cleanup();
    }
  });

  it.skipIf(process.platform !== "linux")(
    "screen pid files trust only the recorded process",
    async () => {
      const killHeld = (pids: string[]) => {
        for (const pid of pids) {
          try {
            process.kill(Number(pid), "SIGKILL");
          } catch {
            // The screen stop already reaped it.
          }
        }
      };
      const spawnHeld = (env: NodeJS.ProcessEnv, binary: string, held: string[]) => {
        const started = spawnSync(
          "bash",
          ["-c", 'nohup "$1" </dev/null >/dev/null 2>&1 & echo $!', "hold", binary],
          { encoding: "utf8", env, timeout: 5_000 },
        );
        expect(started.status, started.stderr).toBe(0);
        const pid = started.stdout.trim();
        expect(pid).toMatch(/^\d+$/);
        expect(process.kill(Number(pid), 0)).toBe(true);
        held.push(pid);
        return pid;
      };
      const plantOutside = (
        env: NodeJS.ProcessEnv,
        file: string,
        binary: string,
        held: string[],
      ) => {
        const original = readFileSync(file, "utf8");
        const recordedStart = original.trim().split(/\s+/)[1];
        let outside = "";
        for (let attempt = 0; attempt < 6; attempt += 1) {
          outside = spawnHeld(env, binary, held);
          if (recordedStart === undefined || procStartTime(outside) !== recordedStart) break;
          process.kill(Number(outside), "SIGKILL");
          spawnSync("sleep", ["0.02"]);
        }
        if (recordedStart !== undefined) expect(procStartTime(outside)).not.toBe(recordedStart);
        writeFileSync(file, original.replace(/^\d+/, outside));
        return outside;
      };
      const waitDead = async (alive: (pid: string) => boolean, pid: string) => {
        for (let i = 0; i < 50 && alive(pid); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(alive(pid)).toBe(false);
      };
      const replaceBinary = (file: string, source: string) => {
        unlinkSync(file);
        copyFileSync(source, file);
        chmodSync(file, 0o755);
      };

      const recycled = await portalScreenFixture();
      const recycledHeld: string[] = [];
      try {
        const command = recycled.relocate(
          ensureScreenCommand(1, "extra", "viewtok", recycled.screenEnv),
        );
        const stop = recycled.relocate(stopExtraScreenCommand(1, "extra", recycled.screenEnv));
        const portalFile = path.join(recycled.runtime, `portal-pid-${recycled.extraDisplay}`);
        const dbusFile = path.join(recycled.runtime, `dbus-pid-${recycled.extraDisplay}`);
        const gtkFile = path.join(recycled.runtime, `portal-gtk-pid-${recycled.extraDisplay}`);
        const killRecorded = async (file: string) => {
          const pid = recordedPid(readFileSync(file, "utf8"));
          process.kill(Number(pid), "SIGKILL");
          await waitDead(recycled.alive, pid);
        };
        const retarget = async () => {
          const started = recycled.run(command, true);
          expect(started.status, started.stderr).toBe(0);
          await killRecorded(portalFile);
          await killRecorded(dbusFile);
          await killRecorded(gtkFile);
          return {
            portal: plantOutside(
              recycled.runEnv,
              portalFile,
              path.join(recycled.libexec, "xdg-desktop-portal"),
              recycledHeld,
            ),
            dbus: plantOutside(
              recycled.runEnv,
              dbusFile,
              path.join(recycled.bin, "dbus-daemon"),
              recycledHeld,
            ),
            gtk: plantOutside(
              recycled.runEnv,
              gtkFile,
              path.join(recycled.libexec, "xdg-desktop-portal-gtk"),
              recycledHeld,
            ),
          };
        };

        const outside = await retarget();
        const stopped = recycled.run(stop, false);
        expect(stopped.status, stopped.stderr).toBe(0);
        expect(recycled.alive(outside.portal)).toBe(true);
        expect(recycled.alive(outside.dbus)).toBe(true);
        expect(recycled.alive(outside.gtk)).toBe(true);

        const resetOutside = await retarget();
        const reset = recycled.run(
          recycled.relocate(resetDesktopRuntimeCommand(recycled.screenEnv)),
          false,
        );
        expect(reset.status, reset.stderr).toBe(0);
        expect(recycled.alive(resetOutside.portal)).toBe(true);
        expect(recycled.alive(resetOutside.dbus)).toBe(true);
        expect(recycled.alive(resetOutside.gtk)).toBe(true);

        const ensuredOutside = await retarget();
        const launches = readFileSync(recycled.dbusLog, "utf8");
        const ensured = recycled.run(command, true);
        expect(ensured.status, ensured.stderr).toBe(0);
        expect(recycled.alive(ensuredOutside.portal)).toBe(true);
        expect(recycled.alive(ensuredOutside.dbus)).toBe(true);
        expect(recycled.alive(ensuredOutside.gtk)).toBe(true);
        const freshPortal = recordedPid(readFileSync(portalFile, "utf8"));
        expect(freshPortal).not.toBe(ensuredOutside.portal);
        expect(recycled.alive(freshPortal)).toBe(true);
        expect(recordedPid(readFileSync(dbusFile, "utf8"))).not.toBe(ensuredOutside.dbus);
        expect(readFileSync(recycled.dbusLog, "utf8")).toBe(`${launches}launch\n`);
      } finally {
        killHeld(recycledHeld);
        recycled.cleanup();
      }

      const replaced = await portalScreenFixture();
      try {
        const command = replaced.relocate(
          ensureScreenCommand(1, "extra", "viewtok", replaced.screenEnv),
        );
        const gtkFile = path.join(replaced.runtime, `portal-gtk-pid-${replaced.extraDisplay}`);
        const started = replaced.run(command, true);
        expect(started.status, started.stderr).toBe(0);
        const gtkBefore = readFileSync(gtkFile, "utf8");
        const gtkPid = recordedPid(gtkBefore);
        const pidsBefore = readFileSync(replaced.pidLog, "utf8");
        const portalsBefore = readFileSync(replaced.portalLog, "utf8");
        const gtkBinary = path.join(replaced.libexec, "xdg-desktop-portal-gtk");
        replaceBinary(gtkBinary, replaced.pythonBin);
        expect(readlinkSync(`/proc/${gtkPid}/exe`)).toMatch(
          /\/xdg-desktop-portal-gtk \(deleted\)$/,
        );
        const again = replaced.run(command, true);
        expect(again.status, again.stderr).toBe(0);
        expect(readFileSync(gtkFile, "utf8")).toBe(gtkBefore);
        expect(readFileSync(replaced.portalLog, "utf8")).toBe(portalsBefore);
        const seenPids = new Set(pidsBefore.split("\n").filter((line) => line.length > 0));
        for (const pid of readFileSync(replaced.pidLog, "utf8").split("\n")) {
          if (pid.length === 0 || seenPids.has(pid)) continue;
          let exe = "";
          try {
            exe = readlinkSync(`/proc/${pid}/exe`);
          } catch {
            exe = "";
          }
          expect(exe).not.toContain("xdg-desktop-portal-gtk");
        }
        expect(replaced.alive(gtkPid)).toBe(true);
        const stopped = replaced.run(
          replaced.relocate(stopExtraScreenCommand(1, "extra", replaced.screenEnv)),
          false,
        );
        expect(stopped.status, stopped.stderr).toBe(0);
        expect(replaced.alive(gtkPid)).toBe(false);
        expect(existsSync(gtkFile)).toBe(false);

        writeFileSync(replaced.dbusLog, "");
        const restarted = replaced.run(command, true);
        expect(restarted.status, restarted.stderr).toBe(0);
        expect(readFileSync(replaced.dbusLog, "utf8")).toBe("launch\n");
        const dbusFile = path.join(replaced.runtime, `dbus-pid-${replaced.extraDisplay}`);
        const dbusBefore = readFileSync(dbusFile, "utf8");
        const dbusPid = recordedPid(dbusBefore);
        const launches = readFileSync(replaced.dbusLog, "utf8");
        replaceBinary(path.join(replaced.bin, "dbus-daemon"), replaced.pythonBin);
        expect(readlinkSync(`/proc/${dbusPid}/exe`)).toMatch(/\/dbus-daemon \(deleted\)$/);
        const kept = replaced.run(command, true);
        expect(kept.status, kept.stderr).toBe(0);
        expect(readFileSync(replaced.dbusLog, "utf8")).toBe(launches);
        expect(readFileSync(dbusFile, "utf8")).toBe(dbusBefore);
        expect(replaced.alive(dbusPid)).toBe(true);
        const stoppedBus = replaced.run(
          replaced.relocate(stopExtraScreenCommand(1, "extra", replaced.screenEnv)),
          false,
        );
        expect(stoppedBus.status, stoppedBus.stderr).toBe(0);
        expect(replaced.alive(dbusPid)).toBe(false);
        expect(existsSync(dbusFile)).toBe(false);
      } finally {
        replaced.cleanup();
      }

      const legacy = await portalScreenFixture();
      const legacyHeld: string[] = [];
      try {
        const portalFile = path.join(legacy.runtime, `portal-pid-${legacy.extraDisplay}`);
        const dbusFile = path.join(legacy.runtime, `dbus-pid-${legacy.extraDisplay}`);
        const gtkFile = path.join(legacy.runtime, `portal-gtk-pid-${legacy.extraDisplay}`);
        const busFile = path.join(legacy.runtime, `dbus-session-${legacy.extraDisplay}`);
        const outsidePortal = spawnHeld(
          legacy.runEnv,
          path.join(legacy.libexec, "xdg-desktop-portal"),
          legacyHeld,
        );
        const outsideDbus = spawnHeld(
          legacy.runEnv,
          path.join(legacy.bin, "dbus-daemon"),
          legacyHeld,
        );
        const outsideGtk = spawnHeld(
          legacy.runEnv,
          path.join(legacy.libexec, "xdg-desktop-portal-gtk"),
          legacyHeld,
        );
        const plantLegacy = () => {
          writeFileSync(portalFile, outsidePortal);
          writeFileSync(dbusFile, outsideDbus);
          writeFileSync(gtkFile, outsideGtk);
          writeFileSync(busFile, "export DBUS_SESSION_BUS_ADDRESS=unix:path=/legacy\n");
        };
        plantLegacy();
        const stopped = legacy.run(
          legacy.relocate(stopExtraScreenCommand(1, "extra", legacy.screenEnv)),
          false,
        );
        expect(stopped.status, stopped.stderr).toBe(0);
        expect(legacy.alive(outsidePortal)).toBe(true);
        expect(legacy.alive(outsideDbus)).toBe(true);
        expect(legacy.alive(outsideGtk)).toBe(true);
        plantLegacy();
        const ensured = legacy.run(
          legacy.relocate(ensureScreenCommand(1, "extra", "viewtok", legacy.screenEnv)),
          true,
        );
        expect(ensured.status, ensured.stderr).toBe(0);
        expect(legacy.alive(outsidePortal)).toBe(true);
        expect(legacy.alive(outsideDbus)).toBe(true);
        expect(legacy.alive(outsideGtk)).toBe(true);
        expect(recordedPid(readFileSync(portalFile, "utf8"))).not.toBe(outsidePortal);
        expect(recordedPid(readFileSync(dbusFile, "utf8"))).not.toBe(outsideDbus);
        expect(recordedPid(readFileSync(gtkFile, "utf8"))).not.toBe(outsideGtk);
        expect(existsSync(legacy.dbusLog) ? readFileSync(legacy.dbusLog, "utf8") : "").toBe(
          "launch\n",
        );
      } finally {
        killHeld(legacyHeld);
        legacy.cleanup();
      }
    },
    120_000,
  );
});
