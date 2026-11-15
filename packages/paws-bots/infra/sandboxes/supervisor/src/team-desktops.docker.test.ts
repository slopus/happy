import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  browserLauncherPath,
  DEFAULT_DESKTOP_ENV,
  desktopControlCommand,
  managedDesktopCommand,
  releaseDesktopCommand,
  screenPorts,
  stopAllDesktopBrowsersCommand,
} from "@rakazo/core/node/desktop-runtime";
import { expect, it } from "vitest";
import {
  browserProfilePathForScreen,
  ensureScreenCommand,
  interactiveScreenCommand,
  resetManagedScreensCommand,
  stopExtraScreenCommand,
} from "./supervisor-logic.js";

// Build the computer image first. This opt-in check needs Docker but no network or credentials.
it.skipIf(process.env.VERIFY_DOCKER_TEAM_SCREENS !== "1").each([false, true])(
  "isolates live desktops, persists profiles, and revokes recycled capabilities (managed=%s)",
  (managed) => {
    const name = `rakazo-team-screens-test-${randomUUID()}`;
    const directory = mkdtempSync(path.join(tmpdir(), "rakazo-team-screens-"));
    const docker = (...args: string[]) =>
      execFileSync("docker", args, { encoding: "utf8", timeout: 150_000 });
    try {
      const env = managed
        ? {
            ...DEFAULT_DESKTOP_ENV,
            preservePrimaryDisplay: false,
            displayStart: 20,
            portStart: 6100,
          }
        : DEFAULT_DESKTOP_ENV;
      const commands: Record<string, string> = {
        reset: resetManagedScreensCommand(),
        seed: managed
          ? `python3 -c 'from pathlib import Path; d=Path("/tmp/rakazo/desktop-assignments"); [(d / ("fixture-%s.slot" % i)).write_text(str(i) + "\\n") for i in range(1, 99)]'`
          : "true",
        closeall: stopAllDesktopBrowsersCommand(env),
        viewPort: screenPorts(0, env).viewPort,
        controlPort: screenPorts(0, env).controlPort,
        gh: "gh --version",
      };
      for (const [bot, index] of [
        ["a", 0],
        ["b", 99],
        ["c", 0],
      ] as const) {
        commands[`ensure${bot}`] = managed
          ? managedDesktopCommand(`bot-${bot}`, `run-${bot}:1`, env, `view-${bot}`)
          : ensureScreenCommand(index, `bot-${bot}`, `view-${bot}`, env);
        commands[`open${bot}`] =
          `nohup ${browserLauncherPath(screenPorts(index, env).displayNumber)} http://127.0.0.1:${bot === "b" ? 8091 : 8090}/${bot} </dev/null >/tmp/browser-open-${bot}.log 2>&1 &`;
        commands[`debug${bot}`] = String(screenPorts(index, env).debugPort);
        commands[`stop${bot}`] = managed
          ? releaseDesktopCommand(`bot-${bot}`, `run-${bot}:1`, env)
          : stopExtraScreenCommand(index, `bot-${bot}`, env);
        commands[`profile${bot}`] = browserProfilePathForScreen(`bot-${bot}`, env);
        commands[`display${bot}`] = String(screenPorts(index, env).displayNumber);
        commands[`control${bot}`] = managed
          ? desktopControlCommand(`bot-${bot}`, `run-${bot}:1`, env, true, `control-${bot}`)
          : interactiveScreenCommand(true, `control-${bot}`, screenPorts(index, env));
      }
      const commandFile = path.join(directory, "commands.json");
      writeFileSync(commandFile, JSON.stringify(commands));
      docker(
        "run",
        "-d",
        "--name",
        name,
        "--network",
        "none",
        "--shm-size=512m",
        process.env.RAKAZO_COMPUTER_IMAGE ?? "rakazo/computer:local",
      );
      docker("cp", commandFile, `${name}:/tmp/team-desktops-commands.json`);
      docker(
        "cp",
        fileURLToPath(new URL("../../computer/test_team_desktops.py", import.meta.url)),
        `${name}:/tmp/test_team_desktops.py`,
      );
      expect(
        docker(
          "exec",
          name,
          "python3",
          "/tmp/test_team_desktops.py",
          "/tmp/team-desktops-commands.json",
        ),
      ).toContain("PASS: parallel desktops");
    } finally {
      try {
        docker("rm", "-f", name);
      } catch {
        // Cleanup must not replace the original test failure.
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  },
  180_000,
);
