import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("keeps the Lark SDK dynamic in a production server bundle", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const outfile = path.join(root, "apps/api/dist/index.js");
  const builtins = new Set(builtinModules);
  // Mirror scripts/build-server.mjs: one ESM bundle, workspace sources bundled,
  // dependencies externalized to importer-relative paths with resolution kind preserved.
  const result = await build({
    entryPoints: [path.join(root, "packages/adapters/src/messaging-platforms.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: true,
    conditions: ["node"],
    logLevel: "warning",
    write: false,
    plugins: [
      {
        name: "external-node-modules",
        setup(builder) {
          builder.onResolve({ filter: /^[^./]/ }, async (args) => {
            if (args.pluginData?.inner) return undefined;
            if (args.path.startsWith("node:") || builtins.has(args.path)) {
              return { path: args.path, external: true };
            }
            if (args.path.startsWith("@rakazo/")) return undefined;
            const resolved = await builder.resolve(args.path, {
              kind: args.kind,
              resolveDir: args.resolveDir,
              importer: args.importer,
              pluginData: { inner: true },
            });
            if (resolved.errors.length > 0) return { errors: resolved.errors };
            let relative = path.relative(path.dirname(outfile), resolved.path);
            if (!relative.startsWith(".")) relative = `./${relative}`;
            return { path: relative.split(path.sep).join("/"), external: true };
          });
        },
      },
    ],
  });
  const output = result.outputFiles.find((file) => file.path === outfile)!.text;
  expect(output).not.toMatch(
    /\bimport\s+(?:[^;]*?\sfrom\s*)?["'][^"']*@larksuiteoapi\/node-sdk[^"']*["']/,
  );
  expect(output).toMatch(/\bimport\(["'][^"']*@larksuiteoapi\/node-sdk[^"']*["']\)/);
});
