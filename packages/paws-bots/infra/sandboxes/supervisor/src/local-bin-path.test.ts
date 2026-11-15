import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const computerRoot = fileURLToPath(new URL("../../computer/", import.meta.url));
const localBinSnippet = path.join(computerRoot, "rakazo-local-bin.sh");

// Debian /etc/profile replaces PATH, then sources /etc/profile.d/*.sh. Bash login
// shells (`bash -lc`) do that before any home profile. Reproduce that order in a
// throwaway home so the test does not depend on the host's /etc/profile.
const LOGIN_SHELL_STARTUP = [
  "set -u",
  'if [ "$(id -u)" -eq 0 ]; then',
  '  PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
  "else",
  '  PATH="/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games"',
  "fi",
  "export PATH",
  '. "$RAKAZO_LOCAL_BIN_SNIPPET"',
  'if [ -f "$HOME/.bash_profile" ]; then',
  '  . "$HOME/.bash_profile"',
  'elif [ -f "$HOME/.bash_login" ]; then',
  '  . "$HOME/.bash_login"',
  'elif [ -f "$HOME/.profile" ]; then',
  '  . "$HOME/.profile"',
  "fi",
].join("\n");

describe("agent shell PATH after Debian login startup", () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it.each(["sh", "bash"])(
    "keeps the sandbox home bin visible with no home profile (%s)",
    (shell) => {
      const home = createHome();
      installHello(home);

      const result = loginShell(home, 'printf "%s\\n" "$PATH"; hello', LOGIN_SHELL_STARTUP, shell);

      expect(result.stdout.split("\n")[0]?.split(":")[0]).toBe(`${home}/.local/bin`);
      expect(result.stdout).toContain("hello-from-local-bin");
    },
  );

  it("does not duplicate an entry that is already present", () => {
    const home = createHome();
    const preset = `${home}/.local/bin:/usr/bin:/bin`;

    const result = loginShell(
      home,
      'printf "%s" "$PATH"',
      // Skip the Debian reset so the snippet sees the supervisor PATH intact.
      [
        `PATH=${shellQuote(preset)}`,
        "export PATH",
        `. ${shellQuote(localBinSnippet)}`,
        `. ${shellQuote(localBinSnippet)}`,
      ].join("\n"),
    );

    expect(result.stdout).toBe(preset);
  });

  it("does not treat a longer path prefix as the sandbox bin", () => {
    const home = createHome();
    const lookalike = `${home}/.local/bin-extra`;
    mkdirSync(lookalike, { recursive: true });

    const result = loginShell(
      home,
      'printf "%s" "$PATH"',
      `PATH=${shellQuote(`${lookalike}:/usr/bin`)}\nexport PATH\n. ${shellQuote(localBinSnippet)}`,
    );

    expect(result.stdout.split(":")).toEqual([`${home}/.local/bin`, lookalike, "/usr/bin"]);
  });

  it("leaves PATH alone when HOME is unset", () => {
    const result = execFileSync(
      "sh",
      ["-c", `unset HOME\n. ${shellQuote(localBinSnippet)}\nprintf "%s" "$PATH"`],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
      },
    );

    expect(result).toBe("/usr/bin:/bin");
  });

  it("still leaves the sandbox bin on PATH when a home profile prepends another directory", () => {
    const home = createHome();
    mkdirSync(path.join(home, "bin"));
    writeFileSync(path.join(home, ".profile"), 'PATH="$HOME/bin:$PATH"\nexport PATH\n');

    const result = loginShell(home, 'printf "%s" "$PATH"');

    const entries = result.stdout.split(":");
    expect(entries[0]).toBe(`${home}/bin`);
    expect(entries).toContain(`${home}/.local/bin`);
  });

  it("installs the snippet where Debian login shells source it", () => {
    const dockerfile = readFileSync(path.join(computerRoot, "Dockerfile"), "utf8");
    const copy = "COPY --chmod=644 rakazo-local-bin.sh /etc/profile.d/rakazo-local-bin.sh";
    const copyAt = dockerfile.indexOf(copy);
    const userAt = dockerfile.indexOf("USER 1000:1000");
    expect(copyAt).toBeGreaterThan(-1);
    expect(userAt).toBeGreaterThan(copyAt);
    expect(dockerfile).toContain("/etc/profile.d/rakazo-local-bin.sh");
  });

  function createHome(): string {
    const home = mkdtempSync(path.join(tmpdir(), "rakazo-local-bin-"));
    homes.push(home);
    return home;
  }
});

function installHello(home: string): void {
  const directory = path.join(home, ".local", "bin");
  mkdirSync(directory, { recursive: true });
  const hello = path.join(directory, "hello");
  writeFileSync(hello, "#!/bin/sh\nprintf 'hello-from-local-bin\\n'\n");
  chmodSync(hello, 0o755);
}

function loginShell(
  home: string,
  command: string,
  startup = LOGIN_SHELL_STARTUP,
  shell = "sh",
): { stdout: string } {
  const stdout = execFileSync(shell, ["-c", `${startup}\n${command}`], {
    encoding: "utf8",
    env: {
      HOME: home,
      LOGNAME: "rakazo",
      PATH: `${home}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      USER: "rakazo",
      RAKAZO_LOCAL_BIN_SNIPPET: localBinSnippet,
    },
  });
  return { stdout: stdout.trim() };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
