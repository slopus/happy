import { E2B_COMPUTER_TEMPLATE, E2B_DESKTOP_TEMPLATE } from "./e2b-template.js";
import type { RemoteDesktopSdk } from "./remote-desktop-sandbox.js";
import { RemoteDesktopSandboxProvider } from "./remote-desktop-sandbox.js";

export type {
  RemoteDesktop as E2BDesktop,
  RemoteDesktopSdk as E2BSandboxSdk,
} from "./remote-desktop-sandbox.js";
export {
  keepingAwake,
  remoteDesktopCreateOptions as e2bCreateOptions,
} from "./remote-desktop-sandbox.js";

/** The SDK loads only when an E2B computer is used, never in the default runtime. */
const e2b = async () => (await import("@e2b/desktop")).Sandbox;

// The lifecycle and job runner own retries. The SDK's own would stack under them, hold a call open
// through its backoff, and replay a create whose 503 may have started a sandbox. A connected
// sandbox keeps this for its later API calls.
const noRetries = { retries: 0 };

const e2bSdk: RemoteDesktopSdk = {
  create: async (template, options) => (await e2b()).create(template, { ...options, ...noRetries }),
  connect: async (id, options) => (await e2b()).connect(id, { ...options, ...noRetries }),
  isRunning: async (id, options) =>
    (await (await e2b()).getInfo(id, { ...options, ...noRetries })).state === "running",
  pause: async (id, options) => (await e2b()).pause(id, { ...options, ...noRetries }),
  kill: async (id, options) => (await e2b()).kill(id, { ...options, ...noRetries }),
};

export class E2BSandboxProvider extends RemoteDesktopSandboxProvider {
  constructor(apiKey: string, sdk: RemoteDesktopSdk = e2bSdk) {
    super({
      id: "e2b",
      label: "E2B",
      apiKey,
      sdk,
      template: E2B_COMPUTER_TEMPLATE,
      fallbackTemplate: E2B_DESKTOP_TEMPLATE,
      isTimeoutError: (error) => error instanceof Error && error.name === "TimeoutError",
    });
  }
}
