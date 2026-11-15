import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it("lists flows without a generated Prisma client", () => {
  // Make the client unavailable to this process without changing files used by other tests.
  const guard = `
    import { registerHooks } from 'node:module';
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier.includes('generated/prisma')) {
          const error = new Error('Prisma client is not generated');
          error.code = 'ERR_MODULE_NOT_FOUND';
          throw error;
        }
        return nextResolve(specifier, context);
      }
    });
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      `data:text/javascript,${encodeURIComponent(guard)}`,
      path.resolve(import.meta.dirname, "../cli/flows.ts"),
      "--list",
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => line.split("\t")[0]),
  ).toEqual(["weekly-shopping", "connect-mcp"]);
});
