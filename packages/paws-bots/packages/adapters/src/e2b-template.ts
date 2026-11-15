import type { BuildOptions, TemplateClass } from "@e2b/desktop";

/** E2B's stock desktop image, which reserves 8 vCPU and 8 GB for every sandbox. */
export const E2B_DESKTOP_TEMPLATE = "desktop";
/** The same desktop at the size a bot computer needs; see buildE2BComputerTemplate. */
export const E2B_COMPUTER_TEMPLATE = "rakazo-computer";

/**
 * A computer runs one desktop per active bot (Xvfb, fluxbox, x11vnc, Chromium) plus shell
 * work. Two cores keep the desktop and a browser responsive; 4 GB leaves room for a second
 * bot's Chromium on a Team Computer, where 2 GB would start swapping or killing tabs.
 */
const E2B_COMPUTER_RESOURCES = { cpuCount: 2, memoryMB: 4096 } as const;

type BuildTemplate = (
  template: TemplateClass,
  name: string,
  options: Omit<BuildOptions, "alias">,
) => Promise<{ name: string }>;

/** Publish the Rakazo computer template to the E2B team that owns this API key. */
export async function buildE2BComputerTemplate(
  apiKey: string,
  options: {
    build?: BuildTemplate;
    onBuildLogs?: (line: string) => void;
  } = {},
) {
  const { Template } = await import("@e2b/desktop");
  const build: BuildTemplate =
    options.build ??
    ((template, name, buildOptions) => Template.build(template, name, buildOptions));
  return build(Template().fromTemplate(E2B_DESKTOP_TEMPLATE), E2B_COMPUTER_TEMPLATE, {
    apiKey,
    ...E2B_COMPUTER_RESOURCES,
    ...(options.onBuildLogs
      ? { onBuildLogs: (entry) => options.onBuildLogs?.(entry.toString()) }
      : {}),
  });
}
