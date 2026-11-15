import { getLogger } from "@rakazo/logging";
import type { ComputerEgressMode } from "./computer-spec.js";
import { COMPUTER_IMAGE } from "./computer-spec.js";
import { computerDns, computerEgressSetting, docker, screenNetworkMode } from "./context.js";
import { EgressNotEnforced, verifyRestrictedEgress } from "./egress-probe.js";

// `auto` starts open and becomes restricted once the probe shows the host rules are in place.
export let computerEgressMode: ComputerEgressMode =
  computerEgressSetting === "restricted" || computerEgressSetting === "proxy"
    ? computerEgressSetting : "open";
// Enforcement is host-side (DOCKER-USER/INPUT on rakazo-c* bridges); the flag only
// names the interfaces. Refuse restricted computers until a probe shows the host
// rules are in place. Only success is cached, so installing the rules needs no restart.
// `auto` keeps the first answer a completed probe gives: restricted when the rules are in place,
// otherwise open with a warning, which is how computers ran before the rules existed. A probe
// that could not finish decides nothing: the provision fails and the next one probes again.
// In both modes, once the rules are in place, a configured SANDBOX_COMPUTER_DNS that no server
// answers fails the provision the same way, so the next one probes again.
let restrictedEgressVerified: Promise<void> | undefined;
let autoEgressSettled: Promise<void> | undefined;
export async function ensureRestrictedEgressEnforced() {
  if (computerEgressSetting === "proxy") {
    if (screenNetworkMode !== "isolated") throw new Error("Proxy egress requires isolated computer networks");
    // Each provision verifies an owned internal bridge with isolated gateway
    // mode and connects the public-only proxy before starting the guest.
    return;
  }
  if (screenNetworkMode === "internal") return;
  if (computerEgressSetting === "auto") {
    autoEgressSettled ??= verifyRestrictedEgress(docker, COMPUTER_IMAGE, computerDns).then(
      () => {
        computerEgressMode = "restricted";
        getLogger().info("restricted computer egress verified");
      },
      (error) => {
        if (!(error instanceof EgressNotEnforced)) {
          autoEgressSettled = undefined;
          throw error;
        }
        getLogger().warn("computer egress is open: the host firewall rules are not installed", {
          error: error.message,
        });
      },
    );
    return autoEgressSettled;
  }
  if (computerEgressMode !== "restricted") return;
  restrictedEgressVerified ??= verifyRestrictedEgress(docker, COMPUTER_IMAGE, computerDns).catch(
    (error) => {
      restrictedEgressVerified = undefined;
      throw error;
    },
  );
  await restrictedEgressVerified;
}
