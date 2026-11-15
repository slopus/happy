import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSER_POLICY, PREPARE_LINUX_DESKTOP } from "./linux-desktop.js";

function prepareDesktop({ repairExitCode = 0, installExitCode = 0, broken = true } = {}) {
  const bin = mkdtempSync(path.join(tmpdir(), "rakazo-prepare-"));
  try {
    const calls = path.join(bin, "calls");
    const repaired = path.join(bin, "repaired");
    const installed = path.join(bin, "installed");
    if (!broken) writeFileSync(repaired, "");
    const fakes = {
      id: "#!/bin/sh\necho 1000\n",
      // Never execute browser policy writes on the test host.
      sudo: '#!/bin/sh\n[ "$1" = -n ] && shift\n[ "$1" = sh ] && exit 0\nexec "$@"\n',
      env: '#!/bin/sh\nshift\nexec "$@"\n',
      "apt-get": `#!/bin/sh
echo "$*" >> ${JSON.stringify(calls)}
case " $* " in
  *" update "*) exit 0 ;;
esac
case " $* " in *" --no-remove "*) ;; *) exit 99 ;; esac
case " $* " in
  *" --fix-broken "*)
    [ ${repairExitCode} -eq 0 ] || exit ${repairExitCode}
    : > ${JSON.stringify(repaired)}
    exit 0 ;;
esac
if [ ! -e ${JSON.stringify(repaired)} ]; then
  echo "E: Unmet dependencies. Try 'apt --fix-broken install'." >&2
  exit 100
fi
[ ${installExitCode} -eq 0 ] || exit ${installExitCode}
: > ${JSON.stringify(installed)}
`,
    };
    for (const [name, script] of Object.entries(fakes)) {
      writeFileSync(path.join(bin, name), script);
      chmodSync(path.join(bin, name), 0o755);
    }
    // The emoji-font check reads an absolute host path, so the call count depends on
    // whether this machine has the font. Point it at a file that always exists so the
    // assertions describe the script, not the host.
    const fontPath = path.join(bin, "NotoColorEmoji.ttf");
    writeFileSync(fontPath, "");
    const prepare = PREPARE_LINUX_DESKTOP.replaceAll(
      "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
      fontPath,
    );
    const result = spawnSync("/bin/sh", ["-c", prepare], {
      env: { PATH: bin },
      encoding: "utf8",
    });
    return {
      ...result,
      installed: existsSync(installed),
      calls: readFileSync(calls, "utf8").trim().split("\n"),
    };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

describe("provider desktop preparation", () => {
  it("repairs pre-existing broken dependencies before retrying the desktop install", () => {
    const result = prepareDesktop();
    expect(result.status).toBe(0);
    expect(result.installed).toBe(true);
    expect(result.calls).toHaveLength(4);
    expect(result.calls[2]).toMatch(/--fix-broken/);
    expect(result.calls[2]).toMatch(/--no-remove/);
    expect(result.calls[3]).toContain("xvfb");
  });

  it("stops if dependencies cannot be repaired without removing packages", () => {
    const result = prepareDesktop({ repairExitCode: 100 });
    expect(result.status).toBe(100);
    expect(result.installed).toBe(false);
    expect(result.calls).toHaveLength(3);
  });

  it("stops after one repair attempt if the desktop install still fails", () => {
    const result = prepareDesktop({ installExitCode: 100 });
    expect(result.status).toBe(100);
    expect(result.installed).toBe(false);
    expect(result.calls).toHaveLength(4);
  });

  it("does not repair dependencies when the first install succeeds", () => {
    const result = prepareDesktop({ broken: false });
    expect(result.status).toBe(0);
    expect(result.installed).toBe(true);
    expect(result.calls).toHaveLength(2);
  });

  it("applies the same browser policy as the computer image", () => {
    const imagePolicy = readFileSync(
      new URL("../../../infra/sandboxes/computer/browser-policy.json", import.meta.url),
      "utf8",
    );
    expect(JSON.parse(BROWSER_POLICY)).toEqual(JSON.parse(imagePolicy));
  });

  it("installs the emoji font and writes the policy for every Chrome-family browser", () => {
    expect(PREPARE_LINUX_DESKTOP).toContain("fonts-noto-color-emoji");
    for (const dir of [
      "/etc/chromium/policies/managed",
      "/etc/opt/chrome/policies/managed",
      "/etc/brave/policies/managed",
    ]) {
      expect(PREPARE_LINUX_DESKTOP).toContain(dir);
    }
    execFileSync("sh", ["-n", "-c", PREPARE_LINUX_DESKTOP]);
  });

  it("still prepares the desktop when only the emoji font cannot be installed", () => {
    const bin = mkdtempSync(path.join(tmpdir(), "rakazo-prepare-"));
    try {
      const calls = path.join(bin, "calls");
      const fakes: Record<string, string> = {
        id: "#!/bin/sh\necho 1000\n",
        sudo: '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
        env: '#!/bin/sh\nwhile [ "${1#*=}" != "$1" ]; do shift; done\nexec "$@"\n',
        // A broken package manager: installs fail, as on images with unmet dependencies.
        "apt-get": `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\ncase "$*" in *fonts-noto-color-emoji*) exit 100;; esac\n`,
      };
      for (const tool of [
        "python3",
        "flock",
        "Xvfb",
        "xdpyinfo",
        "x11vnc",
        "fluxbox",
        "xdotool",
        "wmctrl",
        "scrot",
        "xterm",
        "websockify",
      ]) {
        fakes[tool] = "#!/bin/sh\n";
      }
      for (const [name, script] of Object.entries(fakes)) {
        writeFileSync(path.join(bin, name), script);
        chmodSync(path.join(bin, name), 0o755);
      }
      // The host may have the font installed; point the check at a file that never exists.
      const prepare = PREPARE_LINUX_DESKTOP.replaceAll(
        "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
        path.join(bin, "NotoColorEmoji.ttf"),
      );
      const result = spawnSync("/bin/sh", ["-c", prepare], {
        env: { PATH: bin },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("could not install the emoji font");
      expect(readFileSync(calls, "utf8")).toContain("fonts-noto-color-emoji");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("fails when the package index cannot be updated", () => {
    const bin = mkdtempSync(path.join(tmpdir(), "rakazo-prepare-"));
    try {
      const calls = path.join(bin, "calls");
      // PATH holds only these fakes, so every desktop tool is missing and nothing runs as root.
      const fakes = {
        id: "#!/bin/sh\necho 1000\n",
        sudo: '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n',
        "apt-get": `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\n[ "$1" != update ]\n`,
      };
      for (const [name, script] of Object.entries(fakes)) {
        writeFileSync(path.join(bin, name), script);
        chmodSync(path.join(bin, name), 0o755);
      }
      const result = spawnSync("/bin/sh", ["-c", PREPARE_LINUX_DESKTOP], {
        env: { PATH: bin },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(readFileSync(calls, "utf8").trim()).toBe("update -qq");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
