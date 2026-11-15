import { spawnSync } from "node:child_process";
import path from "node:path";
import { browserProfilePathForScreen } from "@rakazo/core/node/desktop-runtime";
import { describe, expect, it } from "vitest";
import { containerActionStep } from "./supervisor-logic.js";

type ContainerAction = Parameters<typeof containerActionStep>[0];

const profile = browserProfilePathForScreen("test-bot");
const display = ":7";
const controlPath = path.resolve(import.meta.dirname, "../../computer/control.py");

type Verdict = { allowed: boolean; longLived: boolean };
const pending = new Map<string, string[]>();
let verdicts: Map<string, Verdict> | undefined;

// One python3 process judges every argv in the file; spawning per case dominated the suite.
function check(argv: string[]): Verdict {
  const key = JSON.stringify(argv);
  verdicts ??= probeAll();
  const verdict = verdicts.get(key);
  if (!verdict) throw new Error(`argv was not registered before the probe ran: ${key}`);
  return verdict;
}

function probeAll(): Map<string, Verdict> {
  const argvs = [...pending.values()];
  const probe = spawnSync(
    "python3",
    [
      "-c",
      [
        "import importlib.util, json, sys",
        "from unittest.mock import patch",
        "spec = importlib.util.spec_from_file_location('control_probe', sys.argv[1])",
        "module = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(module)",
        "results = []",
        "for argv in json.loads(sys.stdin.read()):",
        "  allowed = module.allowed_control_argv(argv, sys.argv[2])",
        "  long_lived = module.is_long_lived_control(argv) if allowed else False",
        "  if long_lived:",
        "    with patch.object(module.subprocess, 'Popen') as popen:",
        "      popen.return_value.wait.return_value = 0",
        "      module.run_control_argv(argv, sys.argv[2])",
        "      assert popen.call_args.args[0] == argv, 'profile must survive execution'",
        "      assert popen.call_args.kwargs['env']['DISPLAY'] == sys.argv[2]",
        "  results.append({'allowed': allowed, 'longLived': long_lived})",
        "print(json.dumps(results))",
      ].join("\n"),
      controlPath,
      display,
    ],
    { encoding: "utf8", input: JSON.stringify(argvs) },
  );
  expect(probe.status, probe.stderr).toBe(0);
  const results: Verdict[] = JSON.parse(probe.stdout);
  return new Map(results.map((verdict, index) => [JSON.stringify(argvs[index]), verdict]));
}

function register<T extends string[]>(argv: T): T {
  pending.set(JSON.stringify(argv), argv);
  return argv;
}

function generated(action: ContainerAction, browserProfile: string | undefined) {
  const step = containerActionStep(action, display, browserProfile);
  if (!("argv" in step)) throw new Error("expected command");
  return register(step.argv);
}

const appActions: ContainerAction[] = [
  { kind: "open", path: "https://example.com" },
  { kind: "open", path: "screenshots/image #1.png" },
  { kind: "launch", application: "chromium", uri: "https://example.com" },
  { kind: "launch", application: "chromium" },
  { kind: "launch", application: "xterm" },
  { kind: "focus", application: "chromium", uri: "https://example.com" },
  { kind: "focus", application: "chromium" },
  { kind: "focus", application: "xterm" },
];
const inputActions: ContainerAction[] = [
  { kind: "scroll", direction: "down", amount: 4 },
  { kind: "scroll", direction: "up", amount: 4, x: 600, y: 420 },
  { kind: "scroll", direction: "left", amount: 2 },
  { kind: "scroll", direction: "right", amount: 2, x: 40, y: 300 },
  { kind: "key", key: "Enter" },
];

describe.each([undefined, profile])(
  "supervisor/controller argv contract (profile=%s)",
  (browserProfile) => {
    const apps = appActions.map((action) => ({ action, argv: generated(action, browserProfile) }));
    const inputs = inputActions.map((action) => ({
      action,
      argv: generated(action, browserProfile),
    }));

    it("accepts generated app argv and does not treat focus as a long-lived app", () => {
      for (const { action, argv } of apps) {
        if (
          browserProfile &&
          (action.kind === "open" ||
            ((action.kind === "launch" || action.kind === "focus") &&
              action.application === "chromium"))
        ) {
          expect(argv[2]).toBe(`RAKAZO_BROWSER_PROFILE=${browserProfile}`);
        }
        expect(check(argv), JSON.stringify(action)).toEqual({
          allowed: true,
          longLived: action.kind !== "focus",
        });
      }
    });

    it("accepts generated scroll and key input without treating it as long-lived", () => {
      for (const { action, argv } of inputs) {
        expect(check(argv), JSON.stringify(action)).toEqual({ allowed: true, longLived: false });
      }
    });
  },
);

describe("controller argv restrictions", () => {
  const unauthorized = [
    ["env", `DISPLAY=${display}`, `RAKAZO_BROWSER_PROFILE=${profile}`],
    ["env", `DISPLAY=${display}`, "RAKAZO_BROWSER_PROFILE=", "rakazo-browser"],
    ["env", `DISPLAY=${display}`, `RAKAZO_BROWSER_PROFILE=${profile}a`, "rakazo-browser"],
    [
      "env",
      `DISPLAY=${display}`,
      `RAKAZO_BROWSER_PROFILE=${profile.toUpperCase()}`,
      "rakazo-browser",
    ],
    ["env", `DISPLAY=${display}`, `RAKAZO_BROWSER_PROFILE=${profile}`, "xterm"],
    [
      "env",
      `DISPLAY=${display}`,
      `RAKAZO_BROWSER_PROFILE=${profile}`,
      "/usr/bin/xdg-open",
      "https://example.com",
    ],
    ["env", `DISPLAY=${display}`, `RAKAZO_BROWSER_PROFILE=${profile}`, "xdg-open"],
    [
      "env",
      `DISPLAY=${display}`,
      `RAKAZO_BROWSER_PROFILE=${profile}`,
      "rakazo-browser",
      "one",
      "two",
    ],
    ["env", "DISPLAY=:8", `RAKAZO_BROWSER_PROFILE=${profile}`, "rakazo-browser"],
    ["env", "DISPLAY=:8", "xdg-open", "https://example.com"],
    ["env", `DISPLAY=${display}`, "rakazo-focus-or-launch"],
    ["env", `DISPLAY=${display}`, "rakazo-focus-or-launch", "sh"],
    ["env", `DISPLAY=${display}`, "rakazo-focus-or-launch", "rakazo-focus-or-launch"],
    ["env", `DISPLAY=${display}`, "rakazo-focus-or-launch", "/usr/bin/xterm"],
    ["env", `DISPLAY=${display}`, "rakazo-focus-or-launch", "xterm", "one", "two"],
    [
      "env",
      `DISPLAY=${display}`,
      `RAKAZO_BROWSER_PROFILE=${profile}`,
      "rakazo-focus-or-launch",
      "xterm",
    ],
    ["env", "DISPLAY=:8", "rakazo-focus-or-launch", "xterm"],
    ["env", `DISPLAY=${display}`, "LD_PRELOAD=/tmp/unsafe", "xdg-open", "https://example.com"],
    ["env", `DISPLAY=${display}`, "RAKAZO_BROWSER_PROFILE=/tmp/unsafe", "rakazo-browser"],
    ["env", `DISPLAY=${display}`, `RAKAZO_BROWSER_PROFILE=${profile}/../other`, "rakazo-browser"],
    ["env", `DISPLAY=${display}`, `RAKAZO_BROWSER_PROFILE=${profile}`, "sh", "-c", "true"],
    ["env", `DISPLAY=${display}`, `RAKAZO_BROWSER_PROFILE=${profile}`, "xdotool", "key", "Return"],
    [
      "env",
      `DISPLAY=${display}`,
      `RAKAZO_BROWSER_PROFILE=${profile}`,
      `RAKAZO_BROWSER_PROFILE=${profile}`,
      "rakazo-browser",
    ],
  ].map(register);

  it("rejects malformed or unauthorized argv", () => {
    for (const argv of unauthorized) expect(check(argv).allowed, JSON.stringify(argv)).toBe(false);
  });

  const scroll = (...tail: string[]) => register(["env", `DISPLAY=${display}`, "xdotool", ...tail]);
  const aimedScroll = scroll("mousemove", "--", "600", "420", "click", "--repeat", "4", "5");
  it("accepts a scroll aimed at a point: the pointer moves there, then the wheel turns", () => {
    expect(check(aimedScroll).allowed).toBe(true);
  });

  const malformedScrolls = [
    // A repeated left or right click is not a scroll.
    scroll("mousemove", "--", "600", "420", "click", "--repeat", "3", "1"),
    scroll("mousemove", "--", "600", "420", "click", "--repeat", "3", "3"),
    scroll("mousemove", "--", "600", "420", "click", "--repeat", "3", "8"),
    scroll("click", "--repeat", "3", "2"),
    scroll("mousemove", "--", "600", "420", "click", "--repeat", "21", "5"),
    scroll("mousemove", "--", "600", "420", "click", "--repeat", "0", "5"),
    scroll("mousemove", "--", "6e2", "420", "click", "--repeat", "3", "5"),
    scroll("mousemove", "600", "420", "click", "--repeat", "3", "5"),
    scroll("mousemove", "--", "600", "420", "click", "--repeat", "3", "5", "extra"),
    scroll("mousemove", "--", "600", "420", "key", "--repeat", "3", "5"),
    // Digits outside ASCII ("²", Arabic-Indic "٣") are not a count or a coordinate.
    scroll("mousemove", "--", "600", "420", "click", "--repeat", "²", "5"),
    scroll("click", "--repeat", "²", "5"),
    scroll("click", "--repeat", "٣", "5"),
    scroll("mousemove", "--", "٦00", "420", "click", "--repeat", "3", "5"),
  ];
  it("rejects a scroll that isn't the generated shape", () => {
    for (const argv of malformedScrolls) {
      expect(check(argv).allowed, JSON.stringify(argv)).toBe(false);
    }
  });
});
