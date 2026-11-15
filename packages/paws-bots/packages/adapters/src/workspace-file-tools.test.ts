import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { TOOL_RESULT_TEXT_LIMIT } from "./pi-runtime-limits.js";
import type { RunWorkspace } from "./workspace-file-tools.js";
import { readFileFromTool } from "./workspace-file-tools.js";

function fileWorkspace(content: string, runSecrets: string[] = []) {
  const bytes = new TextEncoder().encode(content);
  const computer: ComputerRef = {
    id: "computer-1",
    botId: "bot-1",
    kind: "fake",
    providerRef: "test-sandbox",
  };
  const sandbox = {
    readFile: async () => bytes,
  } as unknown as SandboxProvider;
  const workspace: RunWorkspace = {
    botId: "bot-1",
    computerMode: "dedicated",
    computer: async () => computer,
    markDirty: () => {},
    context: {} as AdapterContext,
    runSecrets,
  };
  return { sandbox, workspace };
}

type ReadFileResult = {
  path?: string;
  content?: string;
  error?: string;
  totalLines?: number;
  startLine?: number;
  endLine?: number;
  nextOffset?: number;
  note?: string;
};

/** Walk a file chunk by chunk the way the model would, following nextOffset. */
async function readFileInChunks(content: string, runSecrets: string[] = []) {
  const { sandbox, workspace } = fileWorkspace(content, runSecrets);
  const chunks: ReadFileResult[] = [];
  let offset: number | undefined;
  for (let call = 0; call < 60; call += 1) {
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "docs/reference.txt",
      ...(offset === undefined ? {} : { offset }),
    })) as ReadFileResult;
    // No read_file result may reach the generic tool-result truncation.
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(TOOL_RESULT_TEXT_LIMIT);
    expect(result.error).toBeUndefined();
    chunks.push(result);
    if (result.nextOffset === undefined) return chunks;
    expect(result.note).toContain(`offset: ${result.nextOffset}`);
    offset = result.nextOffset;
  }
  throw new Error("read_file never reached the end of the file");
}

describe("readFileFromTool ranges", () => {
  const referenceLines = Array.from(
    { length: 700 },
    (_, index) => `Entry ${String(index + 1).padStart(4, "0")} of the packaging reference guide.`,
  );
  const referenceText = referenceLines.join("\n");

  it("returns a 30 kB file in chunks that reassemble the exact original text", async () => {
    expect(new TextEncoder().encode(referenceText).byteLength).toBeGreaterThan(30_000);
    const chunks = await readFileInChunks(referenceText);
    expect(chunks.length).toBeGreaterThan(1);

    const first = chunks[0]!;
    expect(first.startLine).toBe(1);
    expect(first.totalLines).toBe(referenceLines.length);
    expect(first.nextOffset).toBeGreaterThan(1);

    let expectedStart = 1;
    for (const chunk of chunks) {
      expect(chunk.startLine).toBe(expectedStart);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine!);
      expectedStart = chunk.endLine! + 1;
    }
    const last = chunks.at(-1)!;
    expect(last.endLine).toBe(referenceLines.length);
    expect(last.nextOffset).toBeUndefined();
    expect(chunks.map((chunk) => chunk.content).join("\n")).toBe(referenceText);
  });

  it("returns exactly the requested offset and limit lines", async () => {
    const { sandbox, workspace } = fileWorkspace(referenceText);
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "docs/reference.txt",
      offset: 20,
      limit: 5,
    })) as ReadFileResult;
    expect(result.content).toBe(referenceLines.slice(19, 24).join("\n"));
    expect(result.startLine).toBe(20);
    expect(result.endLine).toBe(24);
    expect(result.totalLines).toBe(referenceLines.length);
    expect(result.nextOffset).toBe(25);
  });

  it("clamps a requested range to the end of the file", async () => {
    const { sandbox, workspace } = fileWorkspace(referenceText);
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "docs/reference.txt",
      offset: referenceLines.length - 1,
      limit: 50,
    })) as ReadFileResult;
    expect(result.content).toBe(referenceLines.slice(-2).join("\n"));
    expect(result.endLine).toBe(referenceLines.length);
    expect(result.nextOffset).toBeUndefined();
  });

  it("returns a small file whole when no range is given", async () => {
    const text = "alpha\nbeta\ngamma";
    const { sandbox, workspace } = fileWorkspace(text);
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "notes/short.txt",
    })) as ReadFileResult;
    expect(result).toEqual({
      path: "notes/short.txt",
      content: text,
      totalLines: 3,
      startLine: 1,
      endLine: 3,
    });
  });

  it("ignores range arguments that are not positive integers", async () => {
    const text = "alpha\nbeta\ngamma";
    const { sandbox, workspace } = fileWorkspace(text);
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "notes/short.txt",
      offset: -2,
      limit: 1.5,
    })) as ReadFileResult;
    expect(result.content).toBe(text);
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(3);
  });

  it("redacts a secret that straddles a chunk boundary before the file is split", async () => {
    // Discover where the first chunk boundary falls, then put a secret across it.
    const plainChunks = await readFileInChunks(referenceText);
    const boundary = plainChunks[0]!.endLine!;
    const secret = "tok-live-boundary\nstraddle-secret";
    const lines = [...referenceLines];
    lines[boundary - 1] = `token: tok-live-boundary`;
    lines[boundary] = `straddle-secret ends the entry.`;
    const text = lines.join("\n");

    const chunks = await readFileInChunks(text, [secret]);
    const joined = chunks.map((chunk) => chunk.content).join("\n");
    expect(joined).not.toContain("tok-live-boundary");
    expect(joined).not.toContain("straddle-secret");
    expect(joined).toContain("[redacted]");
    expect(joined).toBe(redactSecrets(text, [secret]));
  });

  it("cuts a single line that alone exceeds the result limit and points past it", async () => {
    const text = `${"a".repeat(20_000)}\nshort tail line`;
    const chunks = await readFileInChunks(text);
    expect(chunks).toHaveLength(2);

    const first = chunks[0]!;
    expect(first.startLine).toBe(1);
    expect(first.endLine).toBe(1);
    expect(first.totalLines).toBe(2);
    expect(first.content!.length).toBeLessThan(20_000);
    expect(first.note).toContain("longer than the result limit");
    expect(first.nextOffset).toBe(2);

    expect(chunks[1]!.content).toBe("short tail line");
    expect(chunks[1]!.startLine).toBe(2);
    expect(chunks[1]!.endLine).toBe(2);
    expect(chunks[1]!.nextOffset).toBeUndefined();
  });

  it("never exposes a secret that crosses the cut inside one oversized line", async () => {
    const secret = "tok-live-cutpoint-secret-000111222333444";
    // Find where the line is cut without redaction, then put the secret across that point:
    // cutting before redacting would leak the part of the secret in front of the cut.
    const unredacted = fileWorkspace("x".repeat(20_000));
    const probe = (await readFileFromTool(unredacted.sandbox, unredacted.workspace, {
      path: "logs/one-line.log",
    })) as ReadFileResult;
    const cut = probe.content!.length;
    const text = `${"x".repeat(cut - 20)}${secret}${"y".repeat(8_000)}`;
    const { sandbox, workspace } = fileWorkspace(text, [secret]);
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "logs/one-line.log",
    })) as ReadFileResult;
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(TOOL_RESULT_TEXT_LIMIT);
    expect(result.content).not.toContain(secret.slice(0, 6));
    expect(result.content).toContain("[redacted]");
    expect(result.note).toContain("longer than the result limit");
    expect(result.nextOffset).toBeUndefined();
  });

  it("reports a clear error when offset is past the end of the file", async () => {
    const { sandbox, workspace } = fileWorkspace("alpha\nbeta\ngamma");
    const result = (await readFileFromTool(sandbox, workspace, {
      path: "notes/short.txt",
      offset: 500,
    })) as ReadFileResult;
    expect(result.error).toContain("past the end");
    expect(result.totalLines).toBe(3);
  });
});
