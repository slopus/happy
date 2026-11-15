import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const computerDir = path.resolve(import.meta.dirname, "../../computer");

describe("focus-or-launch desktop helper", () => {
  // A loaded CI runner can take well over ten seconds to start Python and run these checks.
  it("checks the WM_CLASS matcher and control allowlist offline", { timeout: 70_000 }, () => {
    const tests = fileURLToPath(new URL("../../computer/test_focus_or_launch.py", import.meta.url));
    expect(() =>
      execFileSync("python3", [tests], { timeout: 60_000, stdio: "pipe" }),
    ).not.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "activates a matching window and only spawns when absent",
    async () => {
      const temp = mkdtempSync(path.join(tmpdir(), "focus-or-launch-"));
      const bin = path.join(temp, "bin");
      const argvLog = path.join(temp, "argv");
      const windows = path.join(temp, "windows");
      mkdirSync(bin);
      try {
        writeFileSync(
          path.join(bin, "wmctrl"),
          [
            "#!/bin/sh",
            'if [ "$1" = "-lxp" ]; then cat "$RAKAZO_TEST_WINDOWS";',
            'else printf "wmctrl %s\\n" "$*" >> "$RAKAZO_TEST_ARGS"; fi',
          ].join("\n"),
        );
        for (const name of ["xterm", "rakazo-browser"]) {
          writeFileSync(
            path.join(bin, name),
            `#!/bin/sh\nprintf '${name} %s\\n' "$*" >> "$RAKAZO_TEST_ARGS"\n`,
          );
        }
        // The listed windows are Chromium's, whatever browser the host has.
        writeFileSync(path.join(bin, "chromium"), "#!/bin/sh\n");
        for (const name of ["wmctrl", "xterm", "rakazo-browser", "chromium"]) {
          chmodSync(path.join(bin, name), 0o755);
        }
        const run = async (listing: string, argv: string[], expected: string[]) => {
          writeFileSync(windows, listing);
          writeFileSync(argvLog, "");
          const result = spawnSync(
            "python3",
            [path.join(computerDir, "rakazo-focus-or-launch"), ...argv],
            {
              env: {
                ...process.env,
                PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
                RAKAZO_TEST_WINDOWS: windows,
                RAKAZO_TEST_ARGS: argvLog,
              },
              encoding: "utf8",
            },
          );
          expect(result.status, result.stderr).toBe(0);
          // The launcher is detached; its stub may be scheduled after the helper exits.
          await vi.waitFor(
            () => {
              const actual = readFileSync(argvLog, "utf8")
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean);
              expect(actual).toEqual(expected);
            },
            { timeout: 5_000, interval: 20 },
          );
        };
        const listing = [
          "0x04000001  0 101 uxterm.UXTerm      box  uxterm",
          "0x01800003  0 100 chromium.Chromium  box  Example - Chromium",
          "0x04000003  0 102 xterm.XTerm        box  Terminal",
          "",
        ].join("\n");
        await run(listing, ["xterm"], ["wmctrl -ia 0x04000003"]);
        await run("", ["xterm"], ["xterm"]);
        // A URI still reaches the live browser's launcher, then raises its window.
        await run(
          listing,
          ["rakazo-browser", "https://example.test"],
          ["rakazo-browser https://example.test", "wmctrl -ia 0x01800003"],
        );
        await run(
          "",
          ["rakazo-browser", "https://example.test"],
          ["rakazo-browser https://example.test"],
        );
        // A launcher that stays up must not block the raise of the window already found.
        const pids = path.join(temp, "pids");
        writeFileSync(
          path.join(bin, "rakazo-browser"),
          [
            "#!/bin/sh",
            'printf \'rakazo-browser %s\\n\' "$*" >> "$RAKAZO_TEST_ARGS"',
            `echo $$ >> ${JSON.stringify(pids)}`,
            "exec sleep 30",
            "",
          ].join("\n"),
        );
        chmodSync(path.join(bin, "rakazo-browser"), 0o755);
        writeFileSync(pids, "");
        const started = Date.now();
        await run(
          listing,
          ["rakazo-browser", "https://example.test"],
          ["rakazo-browser https://example.test", "wmctrl -ia 0x01800003"],
        );
        expect(Date.now() - started).toBeLessThan(5_000);
        for (const pid of readFileSync(pids, "utf8").split("\n")) {
          if (!pid.trim()) continue;
          try {
            process.kill(Number(pid), "SIGTERM");
          } catch {
            // The launcher may already have exited.
          }
        }
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );
});
