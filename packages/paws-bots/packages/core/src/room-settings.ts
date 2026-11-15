import type {
  AutomatedSender,
  AutomatedSenderPolicies,
  AutomatedSenderPolicy,
  AutomatedSenderPolicyMode,
} from "@rakazo/contracts";

/** How a room listens: follow the bot's default, listen to everything, or only mentions. */
export type ListenMode = "inherit" | "listen" | "mentions";

export function listenMode(ambient: boolean | null): ListenMode {
  return ambient === null ? "inherit" : ambient ? "listen" : "mentions";
}

export function ambientValue(mode: ListenMode): boolean | null {
  return mode === "inherit" ? null : mode === "listen";
}

export const AUTOMATED_SENDER_MODES = [
  "ignore",
  "rollup",
  "action",
  "user",
] as const satisfies readonly AutomatedSenderPolicyMode[];

export const DEFAULT_ROLLUP_HOURS = 6;
const MIN_ROLLUP_HOURS = 1;
const MAX_ROLLUP_HOURS = 720;

/** Senders seen in the room plus any with a saved policy, by name. */
export function roomAutomatedSenders(
  policies: AutomatedSenderPolicies,
  seen: readonly AutomatedSender[],
): AutomatedSender[] {
  return [
    ...new Map([
      ...Object.entries(policies).map(([id, policy]) => [id, { id, name: policy.name }] as const),
      ...seen.map((sender) => [sender.id, sender] as const),
    ]).values(),
  ].sort((left, right) => left.name.localeCompare(right.name));
}

/** A sender's saved policy; senders without one are ignored. */
export function senderPolicy(
  policies: AutomatedSenderPolicies,
  sender: AutomatedSender,
): AutomatedSenderPolicy {
  return policies[sender.id] ?? { name: sender.name, mode: "ignore" };
}

export function withSenderMode(
  policies: AutomatedSenderPolicies,
  sender: AutomatedSender,
  mode: AutomatedSenderPolicyMode,
): AutomatedSenderPolicies {
  return {
    ...policies,
    [sender.id]: {
      name: sender.name,
      mode,
      ...(mode === "rollup"
        ? { rollupHours: policies[sender.id]?.rollupHours ?? DEFAULT_ROLLUP_HOURS }
        : {}),
    },
  };
}

/** Sets how often a sender's updates are grouped, clamped to the allowed range. */
export function withRollupHours(
  policies: AutomatedSenderPolicies,
  sender: AutomatedSender,
  hours: number,
): AutomatedSenderPolicies {
  const rollupHours = Number.isFinite(hours)
    ? Math.max(MIN_ROLLUP_HOURS, Math.min(MAX_ROLLUP_HOURS, Math.round(hours)))
    : DEFAULT_ROLLUP_HOURS;
  return { ...policies, [sender.id]: { name: sender.name, mode: "rollup", rollupHours } };
}
