import type { TemplateClass } from "@e2b/desktop";
import { Template } from "@e2b/desktop";
import { describe, expect, it, vi } from "vitest";
import {
  buildE2BComputerTemplate,
  E2B_COMPUTER_TEMPLATE,
  E2B_DESKTOP_TEMPLATE,
} from "./e2b-template.js";

describe("E2B computer template", () => {
  it("builds the stock desktop at 2 vCPU and 4 GB under the Rakazo name", async () => {
    const build = vi.fn(async () => ({ name: E2B_COMPUTER_TEMPLATE }));

    await buildE2BComputerTemplate("e2b_test", { build });

    expect(build).toHaveBeenCalledOnce();
    const [template, name, options] = build.mock.calls[0] as unknown as [
      TemplateClass,
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe("rakazo-computer");
    expect(options).toMatchObject({ apiKey: "e2b_test", cpuCount: 2, memoryMB: 4096 });
    expect(JSON.parse(await Template.toJSON(template, false))).toMatchObject({
      fromTemplate: E2B_DESKTOP_TEMPLATE,
    });
  });
});
