import { fileURLToPath } from "node:url";
import { isBuildId } from "@rakazo/contracts/client-build";
import { webDarkTokens } from "@rakazo/ui-tokens";
import type { Plugin, Rolldown } from "vite";
import { CACHE_PREFIX } from "./service-worker.js";

const SERVICE_WORKER_FILE = "sw.js";
const MANIFEST_FILE = "site.webmanifest";
const PRECACHE_PLACEHOLDER = "__RAKAZO_SW_PRECACHE__";
const CACHE_PLACEHOLDER = "__RAKAZO_SW_CACHE__";

export function webManifest() {
  const icons = [192, 512].map((size) => ({
    src: `/icon-${size}.png`,
    sizes: `${size}x${size}`,
    type: "image/png",
  }));
  return {
    id: "/",
    name: "Rakazo",
    short_name: "Rakazo",
    description: "Your team of always-on agents.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: webDarkTokens.background,
    theme_color: webDarkTokens.background,
    // The icons are full-bleed, so the same art also works under a launcher mask.
    icons: [
      ...icons.map((icon) => ({ ...icon, purpose: "any" })),
      ...icons.map((icon) => ({ ...icon, purpose: "maskable" })),
    ],
  };
}

/**
 * Everything the first screen needs offline: the HTML shell, the entry's static
 * import graph, stylesheets and fonts. Lazy chunks are cached as they load.
 */
export function shellFiles(bundle: Rolldown.OutputBundle): string[] {
  const files = new Set(["/"]);
  const visit = (fileName: string) => {
    const chunk = bundle[fileName];
    if (chunk?.type !== "chunk" || files.has(`/${fileName}`)) return;
    files.add(`/${fileName}`);
    for (const css of chunk.viteMetadata?.importedCss ?? []) files.add(`/${css}`);
    chunk.imports.forEach(visit);
  };
  for (const output of Object.values(bundle)) {
    if (output.type === "chunk" && output.isEntry && output.fileName !== SERVICE_WORKER_FILE) {
      visit(output.fileName);
    }
    if (output.type === "asset" && /\.(css|woff2)$/.test(output.fileName)) {
      files.add(`/${output.fileName}`);
    }
  }
  return [...files].sort();
}

/** The cache is named after the build, the same id `/build-id` and every API request carry. */
export function injectShell(code: string, precache: readonly string[], buildId: string): string {
  if (!isBuildId(buildId)) throw new Error(`Expected a build id, got "${buildId}".`);
  const cacheName = `${CACHE_PREFIX}${buildId}`;
  let injected = code;
  for (const [placeholder, value] of [
    [PRECACHE_PLACEHOLDER, precache],
    [CACHE_PLACEHOLDER, cacheName],
  ] as const) {
    const parts = injected.split(placeholder);
    if (parts.length !== 2) throw new Error(`Expected one ${placeholder} in the service worker.`);
    injected = parts.join(JSON.stringify(value));
  }
  return injected;
}

/** Installable PWA shell: the web manifest and the service worker. */
export function rakazoPwa(buildId: string): Plugin[] {
  const manifest = () => JSON.stringify(webManifest(), null, 2);
  return [
    {
      name: "rakazo-pwa-manifest",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split("?", 1)[0] !== `/${MANIFEST_FILE}`) {
            next();
            return;
          }
          res.setHeader("content-type", "application/manifest+json; charset=utf-8");
          res.end(manifest());
        });
      },
    },
    {
      name: "rakazo-pwa-service-worker",
      apply: "build",
      enforce: "post",
      buildStart() {
        this.emitFile({
          type: "chunk",
          id: fileURLToPath(new URL("./sw.ts", import.meta.url)),
          fileName: SERVICE_WORKER_FILE,
        });
      },
      generateBundle(_options, bundle) {
        this.emitFile({ type: "asset", fileName: MANIFEST_FILE, source: manifest() });
        const html = bundle["index.html"];
        if (html?.type !== "asset") this.error("The index.html shell was not emitted.");
        const worker = bundle[SERVICE_WORKER_FILE];
        if (worker?.type !== "chunk") this.error("The service worker chunk was not emitted.");
        // Registered as a classic script, so it must stay one self-contained file.
        if (worker.imports.length || worker.dynamicImports.length || worker.exports.length) {
          this.error("The service worker must not import or export modules.");
        }
        worker.code = injectShell(worker.code, shellFiles(bundle), buildId);
      },
    },
  ];
}
