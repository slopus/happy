import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { HostScreen, HostScreenAction, HostScreenObservation } from "./host-screen.js";
import {
  actThenObserve,
  boundedHostScreenTree,
  HOST_SCREEN_MAX_ELEMENTS,
  HOST_SCREEN_MAX_IMAGE_DIMENSION,
  HostScreenError,
} from "./host-screen.js";

/** The JSON envelope every agent-desktop command prints. */
export interface AgentDesktopEnvelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message?: string; disposition?: { retry?: string } };
}

/** Runs one agent-desktop command to completion and returns its envelope. */
export type AgentDesktopRun = (
  args: readonly string[],
  signal: AbortSignal,
) => Promise<AgentDesktopEnvelope>;

export interface AgentDesktopHostScreenOptions {
  run: AgentDesktopRun;
  /** This app's own process. Driving it could answer its own approval cards. */
  selfPid: number;
  /** Shrinks a PNG so its long edge is at most `maxDimension`. */
  fitImage?: (
    png: Buffer,
    maxDimension: number,
  ) => { png: Buffer; width: number; height: number } | undefined;
}

export const SCREEN_DRIVER_BLOCKED_MESSAGE =
  "Windows stopped screen control from starting on this computer. Security settings such as Smart App Control can block it; ask the user to check them.";

interface AgentDesktopWindow {
  id: string;
  title?: string;
  app_name: string;
  pid: number;
  accessible?: boolean;
  minimized?: boolean;
  visible?: boolean;
}

interface AgentDesktopNode {
  ref_id?: string;
  role?: string;
  name?: string;
  value?: string;
  states?: string[];
  subtree_truncated?: boolean;
  children?: AgentDesktopNode[];
}

interface Target {
  name: string;
  windowId: string;
  title?: string;
}

const LAUNCH_WAIT_MS = 4_000;
const OBSERVE_TIMEOUT_MS = "8000";
const REF = /^@([^:\s]+):e(\d+)$/;
// The OS calls the app primary shortcut modifier ctrl on Windows; cmd there is the Windows key.
const MODIFIERS = { cmd: "ctrl", ctrl: "ctrl", option: "alt", shift: "shift" } as const;

/** A command the CLI refused, with whether it may already have taken effect. */
class AgentDesktopError extends HostScreenError {
  constructor(
    message: string,
    readonly code: string,
    readonly notDelivered: boolean,
  ) {
    super(message);
  }
}

/**
 * Runs agent-desktop as this app's child, one process per command. Its state root stays apart
 * from any standalone install, and it reads only the environment it needs.
 */
export function agentDesktopCli(options: {
  /** Resolves to the executable, fetching it first if needed. */
  command: () => Promise<string>;
  home: string;
}): AgentDesktopRun {
  return async (args, signal) => {
    const command = await options.command();
    return new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        {
          env: { ...getDefaultEnvironment(), AGENT_DESKTOP_HOME: options.home },
          signal,
          timeout: 60_000,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          encoding: "utf8",
        },
        (error, stdout) => {
          if (signal.aborted) return reject(signal.reason);
          const envelope = parseEnvelope(stdout);
          if (envelope) return resolve(envelope);
          reject(
            error?.syscall?.startsWith("spawn")
              ? new HostScreenError(SCREEN_DRIVER_BLOCKED_MESSAGE)
              : (error ?? new Error("no envelope")),
          );
        },
      );
    });
  };
}

function parseEnvelope(stdout: string): AgentDesktopEnvelope | undefined {
  try {
    const value = JSON.parse(stdout) as AgentDesktopEnvelope;
    return typeof value?.ok === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Windows screen control over agent-desktop's UI Automation CLI. Every action is headless: it
 * never moves the pointer, types through the keyboard, or brings a window forward, so gestures
 * that only exist as physical input are refused with a way around them.
 */
export function createAgentDesktopHostScreen(options: AgentDesktopHostScreenOptions): HostScreen {
  const close = new AbortController();
  // The latest snapshot per window: element numbers in actions refer to it.
  const snapshots = new Map<string, string>();

  async function call(app: string, args: string[], signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const both = AbortSignal.any([signal, close.signal]);
    let envelope: AgentDesktopEnvelope;
    try {
      envelope = await options.run(args, both);
    } catch (error) {
      if (signal.aborted || error instanceof HostScreenError) throw error;
      throw new HostScreenError("Screen control stopped responding. Try again.");
    }
    if (envelope.ok) return envelope.data;
    const code = envelope.error?.code ?? "INTERNAL";
    const retry = envelope.error?.disposition?.retry;
    const message = refusal(app, code, envelope.error?.message);
    throw new AgentDesktopError(
      retry && retry !== "safe"
        ? `${message} It may have taken effect; check before repeating it.`
        : message,
      code,
      retry === "safe",
    );
  }

  async function listWindows(query: string, signal: AbortSignal): Promise<AgentDesktopWindow[]> {
    const windows = await call(query, ["list-windows"], signal);
    return Array.isArray(windows)
      ? (windows as AgentDesktopWindow[]).filter((window) => window?.id && window.app_name)
      : [];
  }

  /** Only the exact program the user approved, with or without .exe; a near name could be another app. */
  function named(windows: AgentDesktopWindow[], query: string) {
    const wanted = query.trim().toLowerCase();
    return windows.filter((window) => {
      const name = window.app_name.toLowerCase();
      return name === wanted || name === `${wanted}.exe`;
    });
  }

  function notOpen(windows: AgentDesktopWindow[], query: string) {
    const wanted = query.trim().toLowerCase();
    const near = [
      ...new Set(
        windows
          .map((window) => appName(window))
          .filter((name) => name.toLowerCase().includes(wanted)),
      ),
    ].slice(0, 3);
    return new HostScreenError(
      near.length
        ? `No open app is named exactly "${query}". Open apps with similar names: ${near.join(", ")}.`
        : `No app named "${query}" is open. Ask the user to open it, then try again.`,
    );
  }

  async function windowsWithin(query: string, ms: number, signal: AbortSignal) {
    const deadline = Date.now() + ms;
    for (;;) {
      const matching = named(await listWindows(query, signal), query);
      if (matching.length || Date.now() > deadline) return matching;
      await sleep(400, undefined, { signal });
    }
  }

  async function target(query: string, signal: AbortSignal): Promise<Target> {
    const windows = await listWindows(query, signal);
    let matching = named(windows, query);
    if (!matching.length) {
      // Windows launches only programs it can find by bare name, like notepad.
      const launched = await call(query, ["launch", "--", query], signal).catch((error) => {
        if (!(error instanceof HostScreenError)) throw error;
      });
      if (!launched) throw notOpen(windows, query);
      matching = await windowsWithin(query, LAUNCH_WAIT_MS, signal);
    }
    if (matching.some((window) => window.pid === options.selfPid))
      throw new HostScreenError("Rakazo can't use its own window.");
    const usable = matching.filter(
      (window) => window.accessible !== false && window.visible !== false,
    );
    // The list runs front to back, so the first restored window is the one the user sees.
    const window = usable.find((window) => !window.minimized);
    const name = matching[0] ? appName(matching[0]) : query;
    if (!window)
      throw new HostScreenError(
        usable.length
          ? `${name} is minimized. Ask the user to restore its window, then try again.`
          : `${name} is open but shows no window. Ask the user to open one, then try again.`,
      );
    return { name, windowId: window.id, ...(window.title ? { title: window.title } : {}) };
  }

  async function rows(found: Target, signal: AbortSignal, query?: string) {
    const scope = ["--window-id", found.windowId, "--timeout-ms", OBSERVE_TIMEOUT_MS];
    const data = (await call(
      found.name,
      query
        ? ["find", ...scope, `--text=${query}`, "--limit", String(HOST_SCREEN_MAX_ELEMENTS)]
        : ["snapshot", ...scope, "--compact", "--max-depth", "40"],
      signal,
    )) as {
      snapshot_id?: string;
      complete?: boolean;
      tree?: AgentDesktopNode;
      matches?: AgentDesktopNode[];
      window?: { title?: string };
    } | null;
    const snapshot = typeof data?.snapshot_id === "string" ? data.snapshot_id : "";
    if (snapshot) snapshots.set(found.windowId, snapshot);
    else snapshots.delete(found.windowId);
    const lines: string[] = [];
    let truncated = data?.complete === false;
    const visit = (node: AgentDesktopNode, depth: number) => {
      if (lines.length >= HOST_SCREEN_MAX_ELEMENTS) {
        truncated = true;
        return;
      }
      lines.push(`${"  ".repeat(depth)}- ${row(node, snapshot)}`);
      if (node.subtree_truncated) truncated = true;
      for (const child of node.children ?? []) visit(child, depth + 1);
    };
    if (data?.tree) visit(data.tree, 0);
    for (const match of data?.matches ?? []) visit({ ...match, children: [] }, 0);
    return {
      tree: boundedHostScreenTree(lines.join("\n"), truncated),
      title: data?.window?.title || found.title,
    };
  }

  async function screenshot(found: Target, signal: AbortSignal) {
    const data = (await call(
      found.name,
      ["screenshot", "--window-id", found.windowId],
      signal,
    )) as {
      data?: string;
      format?: string;
      width?: number;
      height?: number;
    } | null;
    if (!data?.data || data.format !== "png" || !data.width || !data.height) return undefined;
    const png = Buffer.from(data.data, "base64");
    const fitted =
      Math.max(data.width, data.height) > HOST_SCREEN_MAX_IMAGE_DIMENSION && options.fitImage
        ? options.fitImage(png, HOST_SCREEN_MAX_IMAGE_DIMENSION)
        : { png, width: data.width, height: data.height };
    return (
      fitted && {
        mimeType: "image/png" as const,
        data: fitted.png.toString("base64"),
        width: fitted.width,
        height: fitted.height,
      }
    );
  }

  async function observeTarget(
    found: Target,
    signal: AbortSignal,
    query?: string,
  ): Promise<HostScreenObservation> {
    const [{ tree, title }, image] = await Promise.all([
      rows(found, signal, query),
      // The tree is what bots act on; a window that refuses capture still has one.
      screenshot(found, signal).catch((error) => {
        if (!(error instanceof HostScreenError)) throw error;
      }),
    ]);
    return { app: found.name, ...(title ? { title } : {}), tree, ...(image ? { image } : {}) };
  }

  function ref(found: Target, element: number) {
    const snapshot = snapshots.get(found.windowId);
    if (!snapshot) throw new HostScreenError(`Observe ${found.name} before using element numbers.`);
    return `@${snapshot}:e${element}`;
  }

  async function perform(found: Target, action: HostScreenAction, signal: AbortSignal) {
    const run = (...args: string[]) => call(found.name, args, signal);
    switch (action.kind) {
      case "click":
        if (action.element === undefined)
          throw new HostScreenError(
            "On Windows, click an element number; clicking a point would move the user's pointer.",
          );
        if (action.double || action.button === "right")
          throw new HostScreenError(
            "On Windows, double and right clicks would move the user's pointer. Click the element, or use set or menu instead.",
          );
        await run("click", "--", ref(found, action.element));
        return;
      case "type":
        throw new HostScreenError(
          "On Windows, type would take over the user's keyboard. Use set with the field's whole new text instead.",
        );
      case "set": {
        const element = ref(found, action.element);
        try {
          await run("set-value", "--", element, action.value);
        } catch (error) {
          // A pop-up or list takes its choice by name rather than as a value.
          if (
            !(error instanceof AgentDesktopError) ||
            error.code !== "ACTION_NOT_SUPPORTED" ||
            !error.notDelivered
          )
            throw error;
          await run("select", "--", element, action.value);
        }
        return;
      }
      case "key": {
        if (action.element !== undefined)
          throw new HostScreenError(
            "On Windows, keys go to whichever element has focus. Leave out element, or use set or click instead.",
          );
        const key = action.key.length === 1 ? action.key.toLowerCase() : action.key;
        const modifiers = [...new Set((action.modifiers ?? []).map((name) => MODIFIERS[name]))];
        await run("press", "--window-id", found.windowId, "--", [...modifiers, key].join("+"));
        return;
      }
      case "scroll": {
        if (action.element === undefined && action.x !== undefined)
          throw new HostScreenError(
            "On Windows, scroll an element number; scrolling at a point would move the user's pointer.",
          );
        const area =
          action.element !== undefined
            ? ref(found, action.element)
            : await first(run, ["find", "--window-id", found.windowId, "--role", "scrollarea"]);
        if (!area) throw new HostScreenError(`Nothing in ${found.name} scrolls.`);
        await run(
          "scroll",
          "--direction",
          action.direction,
          "--amount",
          String(action.amount ?? 3),
          "--",
          area,
        );
        return;
      }
      case "menu": {
        const [top, ...items] = action.path;
        const scope = ["--window-id", found.windowId];
        let item = await first(run, [
          "find",
          ...scope,
          "--role",
          "menuitem",
          `--name=${top}`,
          "--exact",
        ]);
        for (const name of items) {
          if (!item) break;
          await run("click", "--", item);
          item = await first(run, [
            "find",
            ...scope,
            "--surface",
            "menu",
            `--name=${name}`,
            "--exact",
          ]);
        }
        if (!item)
          throw new HostScreenError(`${found.name} has no menu item ${action.path.join(" > ")}.`);
        await run("click", "--", item);
        return;
      }
      case "wait":
        await sleep(action.ms, undefined, { signal });
        return;
    }
  }

  return {
    async observe(scope, app, observeOptions) {
      return observeTarget(await target(app, scope.signal), scope.signal, observeOptions?.query);
    },
    act(scope, app, actions) {
      // Find the window again each time: the last action may have closed it or opened another.
      return actThenObserve(
        scope.signal,
        actions,
        async (action) => perform(await target(app, scope.signal), action, scope.signal),
        async () => observeTarget(await target(app, scope.signal), scope.signal),
      );
    },
    async close() {
      close.abort();
    },
  };
}

/** The first match's element, or undefined when nothing matches. */
async function first(run: (...args: string[]) => Promise<unknown>, args: string[]) {
  const data = (await run(...args, "--first")) as { match?: AgentDesktopNode | null } | null;
  return data?.match?.ref_id;
}

function appName(window: AgentDesktopWindow) {
  return window.app_name.replace(/\.exe$/i, "");
}

function row(node: AgentDesktopNode, snapshot: string) {
  const match = node.ref_id ? REF.exec(node.ref_id) : null;
  const parts = [
    ...(match && match[1] === snapshot ? [`[${match[2]}]`] : []),
    node.role || "element",
    ...(node.name ? [JSON.stringify(node.name)] : []),
    ...(node.value && node.value !== node.name ? [`= ${JSON.stringify(node.value)}`] : []),
    ...(node.states?.length ? [`(${node.states.join(", ")})`] : []),
  ];
  return parts.join(" ");
}

/** What a refused command means for the bot, without the CLI's internals or file paths. */
function refusal(app: string, code: string, message: string | undefined) {
  switch (code) {
    case "STALE_REF":
    case "SNAPSHOT_NOT_FOUND":
    case "ELEMENT_NOT_FOUND":
    case "AMBIGUOUS_TARGET":
      return `${app} changed since the last observation. Observe it again and use the new element numbers.`;
    case "POLICY_DENIED":
      return `Windows won't send that to ${app} without taking over the user's pointer or keyboard. Use click, set, or menu instead.`;
    case "PERM_DENIED":
      return `Windows doesn't let Rakazo use ${app}, usually because it runs as administrator.`;
    case "APP_UNRESPONSIVE":
      return `${app} is not responding.`;
    case "TIMEOUT":
      return `${app} didn't respond in time. The element may be disabled or still loading.`;
    case "APP_NOT_FOUND":
    case "WINDOW_NOT_FOUND":
      return `${app}'s window closed.`;
    case "ACTION_FAILED":
    case "ACTION_NOT_SUPPORTED":
    case "INVALID_ARGS":
      return message || "That element can't do that.";
    default:
      return "Screen control failed. Try again.";
  }
}
