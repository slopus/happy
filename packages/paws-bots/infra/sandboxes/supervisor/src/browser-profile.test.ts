import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  browserProfilePathForScreen,
  prepareBrowserProfileCommand,
  stopScreensCommand,
} from "./supervisor-logic.js";

const fixtures: string[] = [];
afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "rakazo-profile-test-"));
  fixtures.push(root);
  const home = path.join(root, "home");
  const runtime = path.join(root, "runtime");
  const shared = path.join(home, ".browser-profiles/chromium");
  mkdirSync(shared, { recursive: true });
  mkdirSync(runtime);
  const profile = (bot: string) => browserProfilePathForScreen(bot).replace("/home/rakazo", home);
  const run = (script: string) => {
    // GNU cp's reflink optimization has no macOS equivalent; all copy semantics remain intact.
    const portable =
      process.platform === "darwin" ? script.replaceAll(" --reflink=auto", "") : script;
    // No browser runs here. Stopping one scans every process the host user owns, which
    // outlasts the timeout on a busy host; desktop-runtime tests cover that discovery.
    return spawnSync(
      "bash",
      [
        "-eu",
        "-c",
        portable
          .replaceAll("/tmp/rakazo", runtime)
          .replaceAll("/home/rakazo", home)
          .replaceAll("/proc", path.join(root, "no-proc")),
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
  };
  return { shared, profile, run, runtime };
}

describe("durable independent browser profiles", () => {
  it("keeps both bots' data through stop and restart without copying the default profile", () => {
    const { shared, profile, run } = fixture();
    writeFileSync(path.join(shared, "login"), "legacy-session");
    for (const bot of ["writer", "reader"]) {
      expect(run(prepareBrowserProfileCommand(bot)).status).toBe(0);
      expect(existsSync(path.join(profile(bot), "login"))).toBe(false);
      writeFileSync(path.join(profile(bot), "login"), `${bot}-session`);
    }
    expect(
      run(
        stopScreensCommand([
          { screenId: "writer", index: 0 },
          { screenId: "reader", index: 1 },
        ]),
      ).status,
    ).toBe(0);
    for (const bot of ["writer", "reader"]) {
      expect(run(prepareBrowserProfileCommand(bot)).status).toBe(0);
      expect(readFileSync(path.join(profile(bot), "login"), "utf8")).toBe(`${bot}-session`);
    }
    expect(run(prepareBrowserProfileCommand("new-bot")).status).toBe(0);
    expect(existsSync(path.join(profile("new-bot"), "login"))).toBe(false);
    expect(readFileSync(path.join(shared, "login"), "utf8")).toBe("legacy-session");
  });
});
