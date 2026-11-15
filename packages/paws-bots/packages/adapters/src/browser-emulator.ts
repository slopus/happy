import type { FakeBrowserProviderOptions } from "./fake-browser.js";
import { FakeBrowserProvider } from "./fake-browser.js";

/** Same behavior as fake; a distinct id so conformance covers the emulator path. */
export class EmulatorBrowserProvider extends FakeBrowserProvider {
  constructor(options: FakeBrowserProviderOptions = {}) {
    super(options);
  }

  override describe() {
    return {
      ...super.describe(),
      id: "emulator",
    };
  }
}
