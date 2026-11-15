import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { webDarkTokens, webLightTokens } from "@rakazo/ui-tokens";
import { describe, expect, it } from "vitest";

// index.html sets theme-color before any module loads, so it cannot import the
// tokens; this pins its fallbacks to the web palette instead.
describe("index.html theme bootstrap", () => {
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
  const html = read("../../index.html");
  const script = read("../../public/theme.js");

  it("uses the web background tokens for theme-color", () => {
    expect(html).toContain(
      `<meta name="theme-color" content="${webDarkTokens.background.toLowerCase()}" />`,
    );
    expect(script).toContain(
      `theme === "light" ? "${webLightTokens.background.toLowerCase()}" : "${webDarkTokens.background.toLowerCase()}"`,
    );
  });

  it("loads the bootstrap as a file so the CSP needs no inline scripts", () => {
    expect(html).toContain('<script src="/theme.js"></script>');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });

  it.each([
    ["MacIntel", 0, "mac"],
    ["MacIntel", 5, undefined],
    ["Win32", 0, undefined],
    ["Linux x86_64", 0, undefined],
  ] as const)("flags macOS (%s, %i touch points) for its regular weight", (platform, touch, os) => {
    const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
    const run = new Function("document", "navigator", "localStorage", "matchMedia", script);
    run(
      { documentElement: root, querySelector: () => null },
      { platform, maxTouchPoints: touch },
      { getItem: () => null },
      () => ({ matches: false }),
    );
    expect(root.dataset.os).toBe(os);
  });

  it("raises regular text to 420 only on macOS", () => {
    const css = read("../../../../packages/ui-web/src/styles.css");
    expect(css).toMatch(/:root\[data-os="mac"\] \{\s*--font-weight-normal: 420;\s*\}/);
    expect(read("../styles.css")).toContain("font-weight: var(--font-weight-normal);");
  });
});
