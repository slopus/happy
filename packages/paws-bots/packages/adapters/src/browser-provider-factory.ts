import type { BrowserProvider, SandboxProvider } from "@rakazo/adapter-kit";
import { EmulatorBrowserProvider } from "./browser-emulator.js";
import { ComputerBrowserProvider } from "./computer-browser.js";
import type { FakeBrowserProviderOptions } from "./fake-browser.js";
import { FakeBrowserProvider } from "./fake-browser.js";

export type CreateBrowserProviderOptions = FakeBrowserProviderOptions & {
  sandbox?: SandboxProvider;
};

/**
 * Production default is always `computer` (live CDP on the bot computer). Fake and emulator
 * are selected only by BROWSER_PROVIDER=fake or emulator, for offline conformance.
 */
export function resolveBrowserProviderKind(source: NodeJS.ProcessEnv = process.env): string {
  const raw = source.BROWSER_PROVIDER?.trim().toLowerCase();
  if (!raw || raw === "computer" || raw === "sandbox") return "computer";
  if (raw === "fake") return "fake";
  if (raw === "emulator") return "emulator";
  return raw;
}

export function createBrowserProvider(
  kind?: string,
  options?: CreateBrowserProviderOptions,
): BrowserProvider {
  const resolved = (kind ?? resolveBrowserProviderKind()).trim() || resolveBrowserProviderKind();
  switch (resolved) {
    case "computer":
    case "sandbox":
    case "":
      return new ComputerBrowserProvider(options);
    case "fake":
      return new FakeBrowserProvider(options);
    case "emulator":
      return new EmulatorBrowserProvider(options);
    default:
      throw new Error(`Unknown browser provider "${resolved}"`);
  }
}
