import { describe, expect, it } from "vitest";
import { scriptedShell } from "./scripted-shell.js";

describe("scripted eval shell", () => {
  const script = {
    shell: [
      { match: /\bls\b.*extensions/i, output: "midnight" },
      { match: /\bls\b/, output: "ls: cannot access 'x': No such file or directory", exitCode: 2 },
      { match: /\bdf\b/, output: "18G free" },
    ],
    screen: { title: "Example - Browser", dark: true },
  };

  it("keeps a failing check's exit code and stderr, and follows && and ||", () => {
    expect(scriptedShell(script, "ls ~/missing")).toEqual({
      stdout: "",
      stderr: "ls: cannot access 'x': No such file or directory",
      code: 2,
    });
    expect(scriptedShell(script, "ls ~/missing 2>/dev/null && df -h || echo none")).toEqual({
      stdout: "none",
      stderr: "",
      code: 0,
    });
  });

  it("prints echo only when its stdout is not redirected", () => {
    expect(scriptedShell(script, "echo hi > /tmp/x")).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(scriptedShell(script, "echo hi >> /tmp/x")?.stdout).toBe("");
    expect(scriptedShell(script, "echo hi &> /tmp/x")?.stdout).toBe("");
    expect(scriptedShell(script, "echo hi 2>/dev/null")?.stdout).toBe("hi");
  });

  it("hides a check's output when its stdout is redirected", () => {
    expect(scriptedShell(script, "df -h > /dev/null")).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(scriptedShell(script, "df -h 2>/dev/null")?.stdout).not.toBe("");
  });

  it("filters piped output through grep and refuses other pipes", () => {
    expect(scriptedShell(script, "df -h | grep extension")).toEqual({
      stdout: "",
      stderr: "",
      code: 1,
    });
    expect(scriptedShell(script, "df -h | grep -i FREE")).toEqual({
      stdout: "18G free",
      stderr: "",
      code: 0,
    });
    expect(scriptedShell(script, "df -h | grep -c free")?.stdout).toBe("1");
    expect(scriptedShell(script, "df -h | grep -q free")).toEqual({
      stdout: "",
      stderr: "",
      code: 0,
    });
    expect(scriptedShell(script, "df -h | sort")).toBeUndefined();
  });

  it("follows head and tail pipes, quoted alternations, subshells and cd", () => {
    expect(scriptedShell(script, "df -h | head -1")?.stdout).toBe("18G free");
    expect(scriptedShell(script, "df -h | tail -n 5")?.stdout).toBe("18G free");
    expect(scriptedShell(script, "df -h | head -c 3")?.stdout).toBe("18G");
    // A `|` inside quotes, or escaped as basic-regex alternation, is not a pipe.
    expect(scriptedShell(script, 'df -h | grep -iE "nothing|free" | head -5')?.stdout).toBe(
      "18G free",
    );
    expect(scriptedShell(script, 'df -h | grep -i "nothing\\|free"')?.stdout).toBe("18G free");
    expect(scriptedShell(script, "cd ~ 2>/dev/null; (df -h | head -3)")?.stdout).toBe("18G free");
    // A failed check still stops the rest of an && chain, cd included.
    expect(scriptedShell(script, "ls x && cd /tmp && df -h")).toEqual({
      stdout: "",
      stderr: "ls: cannot access 'x': No such file or directory",
      code: 2,
    });
    expect(scriptedShell(script, "echo; (df -h | head -3) 2>/dev/null")?.stdout).toBe("\n18G free");
  });

  it("answers a whole pipeline a check names, when its output can't be derived", () => {
    const counted = {
      shell: [
        { match: /tail\s+-n\s*\+2\s+\S+\s*\|\s*wc\s+-l/, output: "41", whole: true as const },
      ],
      screen: script.screen,
    };
    expect(scriptedShell(counted, "tail -n +2 data.csv | wc -l")?.stdout).toBe("41");
  });

  it("covers no command list with an unscripted command in it", () => {
    expect(scriptedShell(script, "uptime")).toBeUndefined();
    expect(scriptedShell(script, "cat /etc/os-release; df -h")).toBeUndefined();
  });

  it("answers the checks a loop mentions, in the order it mentions them", () => {
    expect(
      scriptedShell(script, 'for d in a b; do df -h "$d"; done; ls ~/extensions 2>/dev/null'),
    ).toEqual({ stdout: "18G free\nmidnight", stderr: "", code: 0 });
  });
});
