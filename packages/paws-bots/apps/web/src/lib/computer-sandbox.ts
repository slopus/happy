import { t } from "@lingui/core/macro";
import type { Me } from "@rakazo/contracts";
import { rpc } from "./rpc";
import { errorText } from "./user-error";

export function computersAreUnavailable(sandboxProvider: string | null | undefined): boolean {
  return sandboxProvider === "none" || sandboxProvider === "";
}

/** Whether an account may run its computers on its own provider on this deployment. */
export function canChooseOwnComputer(sandboxProvider: string | null | undefined): boolean {
  // Those deployments run every computer on the server's own provider.
  return (
    !!sandboxProvider &&
    !computersAreUnavailable(sandboxProvider) &&
    sandboxProvider !== "desktop" &&
    sandboxProvider !== "fake"
  );
}

export type SandboxAvailabilityPhase = "idle" | "loading" | "recovered" | "unavailable" | "failure";

export function sandboxProviderLabel(provider: string): string {
  if (provider === "docker") return "Docker";
  if (provider === "desktop") return "Desktop";
  if (provider === "e2b") return "E2B";
  if (provider === "novita") return "Novita";
  if (provider === "daytona") return "Daytona";
  if (provider === "boat") return "Boat";
  if (provider === "fake") return "Fake";
  return provider;
}

export async function refreshSandboxFromServer(): Promise<Me> {
  const [health, me] = await Promise.all([rpc.health(), rpc.me()]);
  if (!health.ok) {
    throw new Error("Server health check failed");
  }
  return me;
}

export function sandboxCheckFailureMessage(error: unknown): string {
  return errorText(error, t`Could not reach the server`);
}
