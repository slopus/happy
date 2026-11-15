import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

/**
 * The page runtime (React and the kit) as one classic script. The viewer's
 * policy allows only inline scripts, so hosts fetch this text and inline it into the page.
 */
export async function buildPageRuntime(): Promise<string> {
  const result = await build({
    entryPoints: [require.resolve("@rakazo/page-kit/runtime")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["es2020", "safari15"],
    minify: true,
    jsx: "automatic",
    legalComments: "eof",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const [output] = result.outputFiles;
  if (!output) throw new Error("The page runtime build produced no output.");
  return output.text;
}
