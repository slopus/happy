import { describe, expect, it } from "vitest";
import {
  formatAgentEnvironmentInstruction,
  redactAgentCommandResult,
  redactShellStreams,
} from "./agent-environment.js";

describe("agent-environment", () => {
  it("formats an instruction only when secrets exist", () => {
    expect(formatAgentEnvironmentInstruction({})).toBeUndefined();
    expect(formatAgentEnvironmentInstruction({ Z: "1", A: "2" })).toContain("A, Z");
  });

  it("redacts secret values from command output", () => {
    expect(
      redactAgentCommandResult(
        { stdout: "token=super-secret", stderr: "super-secret failed", code: 1 },
        ["super-secret"],
      ),
    ).toEqual({
      stdout: expect.not.stringContaining("super-secret"),
      stderr: expect.not.stringContaining("super-secret"),
      code: 1,
    });
  });

  it("redacts a secret split across stdout and stderr", () => {
    const output = redactAgentCommandResult({ stdout: "pre SECR", stderr: "ET123 post", code: 0 }, [
      "SECRET123",
    ]);
    const joined = `${output.stdout}${output.stderr}`;
    expect(joined).toBe("pre [redacted] post");
    expect(joined).not.toContain("SECRET123");
  });

  it("withholds a secret prefix from a running view and emits it when finished", () => {
    const secret = "super-secret-token";
    expect(
      redactShellStreams({ stdout: "prefix super-", stderr: "" }, [secret], {
        withholdPartial: true,
      }),
    ).toEqual({ stdout: "prefix ", stderr: "" });
    expect(redactShellStreams({ stdout: "prefix super-", stderr: "" }, [secret])).toEqual({
      stdout: "prefix super-",
      stderr: "",
    });
  });

  it("withholds a stdout secret prefix when stderr has unrelated text", () => {
    const secret = "super-secret-token";
    expect(
      redactShellStreams({ stdout: "prefix super-", stderr: "unrelated noise" }, [secret], {
        withholdPartial: true,
      }),
    ).toEqual({ stdout: "prefix ", stderr: "unrelated noise" });
    expect(
      redactShellStreams({ stdout: "unrelated", stderr: "tail super-" }, [secret], {
        withholdPartial: true,
      }),
    ).toEqual({ stdout: "unrelated", stderr: "tail " });
  });

  it("withholds an incomplete secret split across stdout and stderr", () => {
    const secret = "ABCDEFGHIJ";
    expect(
      redactShellStreams({ stdout: "ABCDE", stderr: "FGH" }, [secret], { withholdPartial: true }),
    ).toEqual({ stdout: "", stderr: "" });
    expect(
      redactShellStreams({ stdout: "pre ABCDE", stderr: "FGH tail" }, [secret], {
        withholdPartial: true,
      }),
    ).toEqual({ stdout: "pre ", stderr: " tail" });
    const joined = redactShellStreams({ stdout: "ABCDE", stderr: "FGH" }, [secret], {
      withholdPartial: true,
    });
    expect(`${joined.stdout}${joined.stderr}`).toBe("");
    expect(redactShellStreams({ stdout: "ABCDE", stderr: "FGH" }, [secret])).toEqual({
      stdout: "ABCDE",
      stderr: "FGH",
    });
  });
});
