export type TeachRecordingEvent = {
  at: string;
  kind: "pointer" | "key" | "clipboard" | "snapshot" | "scroll";
  x?: number;
  y?: number;
  button?: string;
  type?: string;
  key?: string;
  text?: string;
  summary?: string;
  sensitive?: boolean;
};

export function sanitizeTeachRecordingEvent(event: TeachRecordingEvent): TeachRecordingEvent {
  if (!event.sensitive) return event;
  const sanitized = { ...event };
  delete sanitized.key;
  delete sanitized.text;
  return sanitized;
}

export type TeachSnapshot = {
  at: string;
  summary: string;
  hash?: string;
};

export type SkillPlaybook = {
  whenToUse: string;
  inputs: string[];
  steps: string[];
  howToCheck: string;
  whatToReturn: string;
  approvalBoundaries: string;
  failureHandling: string;
};

const DEFAULT_APPROVAL =
  "Do not send messages, spend money, publish content, or delete data without explicit user approval.";
const DEFAULT_FAILURE =
  "If a step fails or the expected screen is not visible, stop and ask the user before retrying.";

function describePointer(event: TeachRecordingEvent): string {
  const action = event.type ?? "click";
  const button = event.button ?? "left";
  if (action === "move") {
    return `Move pointer to (${event.x ?? 0}, ${event.y ?? 0}).`;
  }
  if (action === "down") {
    return `Press ${button} button at (${event.x ?? 0}, ${event.y ?? 0}).`;
  }
  if (action === "up") {
    return `Release ${button} button at (${event.x ?? 0}, ${event.y ?? 0}).`;
  }
  return `${action === "click" ? "Click" : action} ${button} button at (${event.x ?? 0}, ${event.y ?? 0}).`;
}

/** The way a scroll goes; anything else scrolls down. */
export function scrollDirection(value: unknown): "up" | "down" | "left" | "right" {
  return value === "up" || value === "left" || value === "right" ? value : "down";
}

function describeScroll(event: TeachRecordingEvent): string {
  const direction = scrollDirection(event.type);
  const amount = Number(event.text ?? 3);
  const at = event.x !== undefined && event.y !== undefined ? ` at (${event.x}, ${event.y})` : "";
  return Number.isFinite(amount) && amount > 1
    ? `Scroll ${direction} ${amount} times${at}.`
    : `Scroll ${direction}${at}.`;
}

const REDACTED_INPUT = "[redacted input]";

function redactSensitiveText(text: string): string {
  const trimmed = text.trim();
  if (/password|secret|token|api[_-]?key/i.test(trimmed)) return REDACTED_INPUT;
  return text;
}

function isTypedCharacter(key: string): boolean {
  return key.length === 1;
}

export function buildPlaybookFromRecording(
  goal: string,
  events: TeachRecordingEvent[],
  snapshots: TeachSnapshot[] = [],
): SkillPlaybook {
  const steps: string[] = [];
  let typed = "";
  let typedSensitive = false;
  let drag: { button: string; fromX: number; fromY: number; toX: number; toY: number } | null =
    null;

  function flushTyped() {
    if (!typed) return;
    const text = redactSensitiveText(typed);
    if (text) steps.push(`Type ${JSON.stringify(text)}.`);
    typed = "";
  }

  function flushSensitiveTyped() {
    if (!typedSensitive) return;
    steps.push(`Type ${JSON.stringify(REDACTED_INPUT)}.`);
    typedSensitive = false;
  }

  function flushPendingInput() {
    flushTyped();
    flushSensitiveTyped();
  }

  function flushDrag() {
    if (!drag) return;
    const moved = Math.hypot(drag.toX - drag.fromX, drag.toY - drag.fromY) >= 8;
    steps.push(
      moved
        ? `Drag ${drag.button} button from (${drag.fromX}, ${drag.fromY}) to (${drag.toX}, ${drag.toY}).`
        : `Click ${drag.button} button at (${drag.fromX}, ${drag.fromY}).`,
    );
    drag = null;
  }

  for (const event of events) {
    if (event.kind === "key") {
      if (event.sensitive) {
        flushDrag();
        flushTyped();
        typedSensitive = true;
        continue;
      }
      const key = event.key;
      if (!key) continue;
      flushDrag();
      if (isTypedCharacter(key)) {
        flushSensitiveTyped();
        typed += key;
        continue;
      }
      flushPendingInput();
      steps.push(`Press key: ${key}.`);
      continue;
    }
    flushPendingInput();
    if (event.kind === "pointer") {
      const action = event.type ?? "click";
      const button = event.button ?? "left";
      const x = event.x ?? 0;
      const y = event.y ?? 0;
      if (action === "down") {
        flushDrag();
        drag = { button, fromX: x, fromY: y, toX: x, toY: y };
        continue;
      }
      if (action === "move" && drag) {
        drag.toX = x;
        drag.toY = y;
        continue;
      }
      if (action === "up") {
        if (drag) {
          drag.toX = x;
          drag.toY = y;
          flushDrag();
        } else {
          steps.push(describePointer(event));
        }
        continue;
      }
      flushDrag();
      steps.push(describePointer(event));
    } else if (event.kind === "clipboard") {
      flushDrag();
      const text = event.sensitive
        ? REDACTED_INPUT
        : event.text
          ? redactSensitiveText(event.text)
          : "";
      if (text) steps.push(`Paste or type: ${text}.`);
    } else if (event.kind === "scroll") {
      flushDrag();
      steps.push(describeScroll(event));
    } else {
      flushDrag();
    }
  }
  flushPendingInput();
  flushDrag();

  if (steps.length === 0) {
    steps.push("Repeat the demonstrated workflow using the same navigation pattern.");
  }

  return {
    whenToUse: goal.trim() || "When the user asks to repeat the demonstrated task.",
    inputs: goal.trim() ? [goal.trim()] : [],
    steps,
    howToCheck: snapshots.at(-1)?.summary
      ? `The final screen should match: ${snapshots.at(-1)?.summary}.`
      : "Confirm the outcome matches the user's goal before reporting success.",
    whatToReturn: "A short summary of what was completed and where outputs were saved.",
    approvalBoundaries: DEFAULT_APPROVAL,
    failureHandling: DEFAULT_FAILURE,
  };
}

const SKILL_RUN_PROMPT_PREFIX = "run taught skill:";
const SKILL_INVOCATION_VERB = /\b(run|use|do|repeat|perform|execute)\b/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A saved skill only takes over a task when the user actually asks for it: an invocation verb
 * plus the whole skill name. A bare substring match would hijack any request that happens to
 * mention a common word used as a skill name.
 */
export function promptInvokesSkill(prompt: string, name: string): boolean {
  const skill = name.trim().toLowerCase();
  const text = prompt.toLowerCase();
  if (skill.length < 3) return false;
  if (text.startsWith(SKILL_RUN_PROMPT_PREFIX)) return false;
  if (!SKILL_INVOCATION_VERB.test(text)) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(skill)}([^\\p{L}\\p{N}]|$)`, "u").test(text);
}

export function formatSkillRunPrompt(name: string, playbook: SkillPlaybook, test = false): string {
  const safety = test
    ? "This is a safe test run. Do not send, spend, delete, or publish anything."
    : "";
  return [
    `Run taught skill: ${name}`,
    safety,
    `When to use: ${playbook.whenToUse}`,
    playbook.inputs.length ? `Inputs: ${playbook.inputs.join("; ")}` : undefined,
    "Steps:",
    ...playbook.steps.map((step, index) => `${index + 1}. ${step}`),
    `How to check: ${playbook.howToCheck}`,
    `Return: ${playbook.whatToReturn}`,
    `Approval boundaries: ${playbook.approvalBoundaries}`,
    `Failure handling: ${playbook.failureHandling}`,
  ]
    .filter(Boolean)
    .join("\n");
}
