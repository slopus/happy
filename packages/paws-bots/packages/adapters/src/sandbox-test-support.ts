import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { expect } from "vitest";

export async function provisionPrepared(
  provider: SandboxProvider,
  request: Parameters<SandboxProvider["provision"]>[0],
  context: AdapterContext,
) {
  const computer = await provider.provision(request, context);
  await provider.prepare(computer, context);
  return computer;
}

export async function assertSandboxWorkspaceContract(
  provider: SandboxProvider,
  computer: ComputerRef,
  ctx: AdapterContext,
) {
  await provider.prepare(computer, ctx);
  let stdout = "";
  for await (const event of provider.execute(computer, { argv: ["echo", "graphical-ok"] }, ctx)) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "exit") expect(event.code).toBe(0);
  }
  expect(stdout).toContain("graphical-ok");
  await provider.writeFile(
    computer,
    { path: "notes/result.txt", content: new TextEncoder().encode("portable") },
    ctx,
  );
  expect(await provider.listFiles(computer, "notes", ctx)).toEqual([
    { path: "notes/result.txt", kind: "file", size: 8 },
  ]);
  expect(new TextDecoder().decode(await provider.readFile(computer, "notes/result.txt", ctx))).toBe(
    "portable",
  );
  const binary = Uint8Array.from([0, 255, 1, 128]);
  await provider.writeFile(computer, { path: "bin/tool", content: binary, executable: true }, ctx);
  expect(await provider.readFile(computer, "bin/tool", ctx)).toEqual(binary);
  expect(await provider.listFiles(computer, "bin", ctx)).toEqual([
    { path: "bin/tool", kind: "file", size: 4, executable: true },
  ]);
  const acted = await provider.act(
    computer,
    {
      actions: [
        { kind: "clipboard", text: "visible" },
        { kind: "focus", application: "xterm" },
      ],
      observe: true,
    },
    ctx,
  );
  expect(acted.completed).toBe(2);
  expect(acted.observation?.image.byteLength).toBeGreaterThan(0);
  const exported = [];
  for await (const file of provider.exportWorkspace(computer, ctx)) exported.push(file);
  expect(exported.map((file) => file.path)).toContain("notes/result.txt");
  expect(exported.find((file) => file.path === "bin/tool")).toMatchObject({
    content: binary,
    executable: true,
  });
}
