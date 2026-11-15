import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  extraDisplayActionCommand,
  extraDisplayInputCommand,
  observeExtraDisplayCommand,
  parseExtraDisplayObservation,
} from "./extra-displays.js";

const run = promisify(execFile);
const cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Fake X tools. scrot appends its display name in slow steps, so overlapping calls on a shared
 * file interleave, and writes enough bytes that the wrapping base64 below splits the output.
 */
function fakeTools() {
  const bin = mkdtempSync(path.join(tmpdir(), "rakazo-observe-bin-"));
  cleanups.push(bin);
  writeFileSync(
    path.join(bin, "scrot"),
    '#!/bin/sh\nfor i in 1 2 3 4 5; do head -c 100 /dev/zero | tr "\\0" "$DISPLAY_CHAR" >> "$2"; sleep 0.05; done\n',
  );
  writeFileSync(path.join(bin, "xdotool"), "#!/bin/sh\necho X=12\necho Y=34\n");
  // Wraps at 76 columns like GNU base64, whatever the host's base64 does.
  writeFileSync(
    path.join(bin, "base64"),
    `#!/bin/sh\nPATH=${JSON.stringify(process.env.PATH)} base64 "$@" | tr -d "\\n" | fold -w 76\n`,
  );
  for (const tool of ["scrot", "xdotool", "base64"]) chmodSync(path.join(bin, tool), 0o755);
  return bin;
}

describe("observing an extra display", () => {
  it("keeps overlapping screenshots of one display apart and removes them", async () => {
    const bin = fakeTools();
    // A display number no other test uses, so only this test's files are counted.
    const displayNumber = 90_000 + process.pid;
    const owned = () =>
      readdirSync("/tmp/rakazo").filter((name) => name.startsWith(`observe-${displayNumber}-`));
    mkdirSync("/tmp/rakazo", { recursive: true });
    const observe = (char: string) =>
      run("sh", ["-c", observeExtraDisplayCommand({ display: ":7", displayNumber })], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DISPLAY_CHAR: char },
      });
    const outputs = await Promise.all([observe("a"), observe("b")]);
    for (const [index, char] of ["a", "b"].entries()) {
      const observed = parseExtraDisplayObservation(outputs[index]!.stdout);
      expect(Buffer.from(observed.image).toString()).toBe(char.repeat(500));
      expect(observed.cursor).toEqual({ x: 12, y: 34 });
    }
    expect(owned()).toEqual([]);
  });
});

describe("extra display scroll", () => {
  const layout = { display: ":3" } as Parameters<typeof extraDisplayActionCommand>[0];

  it("moves the pointer to the scroll's point before turning the wheel", () => {
    expect(
      extraDisplayActionCommand(layout, {
        kind: "scroll",
        direction: "down",
        amount: 4,
        x: 600.4,
        y: 420,
      }),
    ).toBe("DISPLAY=:3 xdotool mousemove 600 420 click --repeat 4 5");
  });

  it("scrolls sideways with the left and right wheel buttons", () => {
    expect(
      extraDisplayActionCommand(layout, {
        kind: "scroll",
        direction: "left",
        amount: 2,
        x: 40,
        y: 300,
      }),
    ).toBe("DISPLAY=:3 xdotool mousemove 40 300 click --repeat 2 6");
    expect(
      extraDisplayActionCommand(layout, { kind: "scroll", direction: "right", amount: 2 }),
    ).toBe("DISPLAY=:3 xdotool click --repeat 2 7");
  });

  it("turns the wheel where the pointer is without a point", () => {
    expect(extraDisplayActionCommand(layout, { kind: "scroll", direction: "up", amount: 2 })).toBe(
      "DISPLAY=:3 xdotool click --repeat 2 4",
    );
  });
});

describe("extra display text input", () => {
  const layout = { display: ":3", displayNumber: 3 };

  it.each([
    "-1200",
    "--help",
    "- first item\n- second item",
    "ordinary text",
    "中文",
    "single ' and double \" quotes",
    "$(printf injected); `printf injected`",
    "",
  ])("passes %j as literal text on both input paths", async (text) => {
    const bin = mkdtempSync(path.join(tmpdir(), "rakazo-input-bin-"));
    cleanups.push(bin);
    // Record argv after shell parsing, without sending input to a real desktop.
    const tool = path.join(bin, "xdotool");
    writeFileSync(tool, '#!/bin/sh\nprintf "%s\\0" "$@"\n');
    chmodSync(tool, 0o755);
    for (const command of [extraDisplayActionCommand, extraDisplayInputCommand]) {
      const { stdout } = await run("sh", ["-c", command(layout, { kind: "clipboard", text })], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      expect(stdout.split("\0")).toEqual(["type", "--", text, ""]);
    }
  });
});
