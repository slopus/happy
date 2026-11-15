import { darkTokens, lightTokens } from "@rakazo/ui-tokens";
import { describe, expect, it } from "vitest";
import { chatMermaidConfig, isMermaidFence, mermaidSvgImage } from "./mermaid";

describe("isMermaidFence", () => {
  it("matches the mermaid info string in any case, with or without attributes", () => {
    expect(isMermaidFence("mermaid")).toBe(true);
    expect(isMermaidFence("Mermaid")).toBe(true);
    expect(isMermaidFence("  mermaid title=flow")).toBe(true);
  });

  it("leaves every other fence alone", () => {
    expect(isMermaidFence("")).toBe(false);
    expect(isMermaidFence(undefined)).toBe(false);
    expect(isMermaidFence("ts")).toBe(false);
    expect(isMermaidFence("mermaidjs")).toBe(false);
    expect(isMermaidFence("text mermaid")).toBe(false);
  });
});

describe("chatMermaidConfig", () => {
  it("keeps Mermaid's sanitizer on and its labels out of HTML", () => {
    const config = chatMermaidConfig(darkTokens, "dark");
    expect(config.securityLevel).toBe("strict");
    expect(config.htmlLabels).toBe(false);
    expect(config.flowchart.htmlLabels).toBe(false);
    expect(config.suppressErrorRendering).toBe(true);
    expect(config.startOnLoad).toBe(false);
    // A diagram's %%{init}%% directive cannot turn either back on.
    expect(config.secure).toEqual(expect.arrayContaining(["securityLevel", "htmlLabels"]));
  });

  it("fills edge labels with the surface the diagram is drawn on", () => {
    const native = chatMermaidConfig(darkTokens, "dark", { surface: darkTokens.background });
    expect(native.themeVariables.background).toBe(darkTokens.background);
    expect(native.themeVariables.edgeLabelBackground).toBe(darkTokens.background);
  });

  it("draws with the app palette so text stays readable in both themes", () => {
    const dark = chatMermaidConfig(darkTokens, "dark");
    expect(dark.darkMode).toBe(true);
    expect(dark.themeVariables.textColor).toBe(darkTokens.foreground);
    expect(dark.themeVariables.primaryTextColor).toBe(darkTokens.foreground);
    expect(dark.themeVariables.background).toBe(darkTokens.card);

    const light = chatMermaidConfig(lightTokens, "light");
    expect(light.darkMode).toBe(false);
    expect(light.themeVariables.textColor).toBe(lightTokens.foreground);
    expect(light.themeVariables.lineColor).toBe(lightTokens.mutedForeground);
  });
});

describe("mermaidSvgImage", () => {
  const svg = (attributes: string, body = "<g/>") =>
    `<svg id="d1" ${attributes} xmlns="http://www.w3.org/2000/svg">${body}</svg>`;

  it("sizes the image from the viewBox instead of the container", () => {
    const image = mermaidSvgImage(
      svg('width="100%" style="max-width: 744.5px;" viewBox="4 4 744.5 57"'),
    );
    expect(image).toMatchObject({ width: 745, height: 57, alt: "Diagram" });
    const markup = decodeURIComponent(image!.src.split(",")[1] ?? "");
    expect(image!.src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(markup).toMatch(/^<svg width="744.5" height="57" id="d1"/);
    expect(markup).not.toContain('width="100%"');
    expect(markup).not.toContain("max-width");
  });

  it("uses the diagram's accessible title as alt text", () => {
    const image = mermaidSvgImage(
      svg('viewBox="0 0 10 10"', '<title id="t">Deploy &amp; verify</title>'),
    );
    expect(image?.alt).toBe("Deploy & verify");
  });

  it("returns nothing for markup without a usable size", () => {
    expect(mermaidSvgImage("<div>not svg</div>")).toBeUndefined();
    expect(mermaidSvgImage(svg('width="100%"'))).toBeUndefined();
    expect(mermaidSvgImage(svg('viewBox="0 0 0 20"'))).toBeUndefined();
  });

  it("keeps a $ in the diagram as text", () => {
    const image = mermaidSvgImage(svg('viewBox="0 0 10 10"', "<text>$& costs $1</text>"));
    expect(decodeURIComponent(image!.src)).toContain("<text>$& costs $1</text>");
  });
});
