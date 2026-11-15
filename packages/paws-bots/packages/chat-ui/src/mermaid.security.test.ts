// @vitest-environment jsdom

import { darkTokens } from "@rakazo/ui-tokens";
import mermaid from "mermaid";
import { expect, it } from "vitest";
import { chatMermaidConfig } from "./mermaid";

it("keeps the real Mermaid config strict despite hostile init directives", async () => {
  mermaid.initialize(chatMermaidConfig(darkTokens, "dark"));
  await mermaid.parse(`%%{init: {"securityLevel":"loose","htmlLabels":true,"flowchart":{"htmlLabels":true},"secure":[]}}%%
graph LR
  A --> B`);
  const config = mermaid.mermaidAPI.getConfig();
  expect(config.securityLevel).toBe("strict");
  expect(config.htmlLabels).toBe(false);
  expect(config.flowchart?.htmlLabels).toBe(false);
  expect(config.secure).toContain("htmlLabels");
});

it("keeps CSS from a diagram's init directive out of the page", async () => {
  mermaid.initialize(chatMermaidConfig(darkTokens, "dark"));
  const css = "background:url(https://example.test/a.png)";
  await mermaid.parse(`%%{init: {"themeCSS":"${css}","fontFamily":"${css}","altFontFamily":"${css}"}}%%
graph LR
  A --> B`);
  expect(JSON.stringify(mermaid.mermaidAPI.getConfig())).not.toContain("example.test");
});
