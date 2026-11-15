import type { AdapterContext, ProcessEvent } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { EvalSandboxProvider } from "./sandbox.js";

const context: AdapterContext = {
  operationId: "eval",
  traceId: "eval",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

describe("honest offline eval shell results", () => {
  it("does not claim a shell-created file exists when it never executed the command", async () => {
    const sandbox = new EvalSandboxProvider();
    const computer = await sandbox.provision({ botId: "bot", homePath: "/fixture" }, context);
    const events: ProcessEvent[] = [];
    for await (const event of sandbox.execute(
      computer,
      {
        argv: [
          "bash",
          "-c",
          "wrapper",
          "rakazo-background-launch",
          "computer",
          "run",
          "call",
          "mkdir -p results && printf 'Hello, workshop!' > results/greeting.txt",
        ],
      },
      context,
    ))
      events.push(event);
    expect(events).toContainEqual({ type: "exit", code: 127 });
    expect(events.some((event) => event.type === "stdout")).toBe(false);
    await expect(sandbox.readFile(computer, "results/greeting.txt", context)).rejects.toThrow();
    expect(sandbox.harnessIssues).toHaveLength(1);
    // The ordinary file tools still execute and produce independently readable artifacts.
    await sandbox.writeFile(
      computer,
      {
        path: "results/greeting.txt",
        content: new TextEncoder().encode("Hello, workshop!"),
      },
      context,
    );
    expect(
      new TextDecoder().decode(await sandbox.readFile(computer, "results/greeting.txt", context)),
    ).toBe("Hello, workshop!");
    await sandbox.destroy(computer, context);
  });
});

describe("scripted eval computer", () => {
  const shell = (command: string) => [
    "bash",
    "-c",
    "wrapper",
    "rakazo-background-launch",
    "computer",
    "run",
    "call",
    command,
  ];
  async function run(sandbox: EvalSandboxProvider, command: string) {
    const computer = await sandbox.provision({ botId: "bot", homePath: "/fixture" }, context);
    const events: ProcessEvent[] = [];
    for await (const event of sandbox.execute(computer, { argv: shell(command) }, context))
      events.push(event);
    return events;
  }
  const script = {
    shell: [
      { match: /\bls\b.*extensions/i, output: "midnight" },
      { match: /\bls\b/, output: "ls: cannot access 'x': No such file or directory", exitCode: 2 },
      { match: /\bdf\b/, output: "18G free" },
    ],
    screen: { title: "Example - Browser", dark: true },
  };

  it("answers each command in a list with the first check it matches", async () => {
    const sandbox = new EvalSandboxProvider(script);
    expect(await run(sandbox, 'echo "--- ext"; ls ~/extensions; df -h')).toEqual([
      { type: "stdout", data: "--- ext\nmidnight\n18G free\n" },
      { type: "exit", code: 0 },
    ]);
    expect(sandbox.harnessIssues).toEqual([]);
  });

  it("refuses a command list when any command in it is not scripted", async () => {
    const sandbox = new EvalSandboxProvider(script);
    expect(await run(sandbox, "uptime")).toContainEqual({ type: "exit", code: 127 });
    expect(await run(sandbox, "cat /etc/os-release; df -h")).toContainEqual({
      type: "exit",
      code: 127,
    });
    expect(sandbox.harnessIssues).toHaveLength(1);
  });

  it("shows the scripted browser window in screenshots", async () => {
    const dark = new EvalSandboxProvider(script);
    const light = new EvalSandboxProvider({ ...script, screen: { ...script.screen, dark: false } });
    const observe = async (sandbox: EvalSandboxProvider) =>
      sandbox.observe(
        await sandbox.provision({ botId: "bot", homePath: "/fixture" }, context),
        context,
      );
    const [a, b] = await Promise.all([observe(dark), observe(light)]);
    expect(a.activeWindow?.title).toBe("Example - Browser");
    expect(a.width).toBeGreaterThan(1);
    expect(a.frameId).not.toBe(b.frameId);
  });
});
