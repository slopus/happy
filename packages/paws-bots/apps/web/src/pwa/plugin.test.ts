import { webDarkTokens } from "@rakazo/ui-tokens";
import type { Rolldown } from "vite";
import { describe, expect, it } from "vitest";
import { injectShell, shellFiles, webManifest } from "./plugin.js";

function chunk(fileName: string, imports: string[], css: string[] = [], isEntry = false) {
  return {
    type: "chunk",
    fileName,
    imports,
    isEntry,
    viteMetadata: { importedCss: new Set(css), importedAssets: new Set() },
  };
}

describe("PWA build", () => {
  it("precaches the shell's static graph, styles and fonts, not lazy chunks", () => {
    const bundle = {
      "assets/index.js": chunk("assets/index.js", ["assets/react.js"], ["assets/index.css"], true),
      "assets/react.js": chunk("assets/react.js", []),
      "assets/lazy.js": chunk("assets/lazy.js", ["assets/react.js"]),
      "sw.js": chunk("sw.js", [], [], true),
      "assets/index.css": { type: "asset", fileName: "assets/index.css" },
      "assets/geist.woff2": { type: "asset", fileName: "assets/geist.woff2" },
      "index.html": { type: "asset", fileName: "index.html" },
    } as unknown as Rolldown.OutputBundle;

    expect(shellFiles(bundle)).toEqual([
      "/",
      "/assets/geist.woff2",
      "/assets/index.css",
      "/assets/index.js",
      "/assets/react.js",
    ]);
  });

  it("names the cache after the build id the client-update handshake uses", () => {
    const code = "install(self,__RAKAZO_SW_PRECACHE__,__RAKAZO_SW_CACHE__)";
    expect(injectShell(code, ["/", "/assets/a.js"], "20261023113220")).toBe(
      'install(self,["/","/assets/a.js"],"rakazo-shell-20261023113220")',
    );
    expect(() => injectShell(code, [], "")).toThrow();
    expect(() => injectShell("install(self)", [], "20261023113220")).toThrow();
  });

  it("takes the manifest colors from the shared tokens", () => {
    const manifest = webManifest();
    expect(manifest).toMatchObject({
      id: "/",
      scope: "/",
      start_url: "/",
      display: "standalone",
      background_color: webDarkTokens.background,
      theme_color: webDarkTokens.background,
    });
    expect(manifest.icons.filter((icon) => icon.purpose === "maskable")).toHaveLength(2);
  });
});
