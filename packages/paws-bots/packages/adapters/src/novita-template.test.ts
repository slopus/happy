import type { BuildOptions, TemplateClass } from "novita-sandbox";
import { Novita } from "novita-sandbox";
import { describe, expect, it, vi } from "vitest";
import { buildNovitaComputerTemplate, NOVITA_COMPUTER_TEMPLATE } from "./novita-template.js";

describe("Novita computer template", () => {
  it.each([undefined, "custom-desktop"])(
    "builds a named desktop at 2 vCPU and 4 GB (%s)",
    async (template) => {
      const client = new Novita({ apiKey: "test-key" });
      const build = vi.spyOn(client.template, "build").mockResolvedValue({
        name: template ?? NOVITA_COMPUTER_TEMPLATE,
        alias: "test",
        tags: [],
        templateId: "test-template",
        buildId: "test-build",
      });
      await buildNovitaComputerTemplate("test-key", { client, template });
      expect(build).toHaveBeenCalledOnce();
      const [builder, name, options] = build.mock.calls[0] as unknown as [
        TemplateClass,
        string,
        Omit<BuildOptions, "alias">,
      ];
      expect(name).toBe(template ?? NOVITA_COMPUTER_TEMPLATE);
      expect(options).toEqual({ cpuCount: 2, memoryMB: 4096 });
      expect(JSON.parse(await client.template.toJSON(builder, false))).toMatchObject({
        fromTemplate: "desktop",
      });
    },
  );
});
