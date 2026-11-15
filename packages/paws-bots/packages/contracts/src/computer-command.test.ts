import { describe, expect, it } from "vitest";
import type { ComputerCommand } from "./events.js";
import { foldComputerCommands } from "./events.js";

describe("computer command history", () => {
  const command = (executionId: string, status: ComputerCommand["status"]): ComputerCommand => ({
    executionId,
    kind: "shell",
    command: `echo ${executionId}`,
    cwd: ".",
    status,
    exitCode: status === "done" ? 0 : null,
    output: "",
  });

  it("keeps one entry per command in start order with its latest state", () => {
    expect(
      foldComputerCommands([
        command("a", "running"),
        command("b", "running"),
        command("b", "done"),
        command("a", "done"),
      ]).map((entry) => `${entry.executionId}:${entry.status}`),
    ).toEqual(["a:done", "b:done"]);
  });

  it("never lets a stale running event reopen a finished command", () => {
    expect(
      foldComputerCommands([command("a", "done"), command("a", "running")]).map(
        (entry) => entry.status,
      ),
    ).toEqual(["done"]);
  });
});
