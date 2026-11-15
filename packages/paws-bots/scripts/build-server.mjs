#!/usr/bin/env node
// Bundle a server entrypoint into plain JavaScript so production boots skip compiling
// TypeScript. Usage: build-server.mjs src/index.ts [src/cli/other.ts ...] -> dist/*.js
//
// Workspace packages ship TypeScript source, so they are bundled in. Everything from
// node_modules stays external, but a bare specifier only resolves from the package that
// declares it (pnpm keeps dependencies strict), not from dist/. Each one is therefore
// rewritten to the relative path of the file it resolves to from its importer.
import { builtinModules } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const builtins = new Set(builtinModules);

/** esbuild options for bundling `entry` into `outfile`, shared with the lazy-vendor check. */
export function serverBuildOptions(entry, outfile) {
  return {
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: true,
    // No "module" condition: resolve externals the way Node will.
    conditions: ["node"],
    logLevel: "warning",
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
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const entry of process.argv.slice(2)) {
    const outfile = path.resolve("dist", path.relative("src", entry).replace(/\.ts$/, ".js"));
    await build(serverBuildOptions(entry, outfile));
  }
}
