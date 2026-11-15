import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { HostScreen, HostScreenAction, HostScreenObservation } from "./host-screen.js";
import {
  actThenObserve,
  boundedHostScreenTree,
  HOST_SCREEN_MAX_ELEMENTS,
  HOST_SCREEN_MAX_IMAGE_DIMENSION,
  HostScreenError,
} from "./host-screen.js";

/** What the driver returns for one tool call: MCP content blocks and structured output. */
export interface CuaToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: Record<string, unknown>;
}

export interface CuaToolClient {
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CuaToolResult>;
  close(): Promise<void>;
}

export interface CuaHostScreenOptions {
  /** Starts a driver process. Called again after the previous one exits or idles out. */
  connect: () => Promise<CuaToolClient>;
  /** Resolves once the OS lets this app read and drive other apps; throws a HostScreenError otherwise. */
  permissions: () => Promise<void>;
  /** This app's own process. Driving it could answer its own approval cards. */
  selfPid: number;
  idleMs?: number;
}

interface CuaApp {
  name: string;
  bundle_id?: string;
  pid: number;
  running: boolean;
  active?: boolean;
}

interface CuaWindow {
  window_id: number;
  pid: number;
  title?: string;
  layer?: number;
  is_on_screen?: boolean;
  z_index?: number | null;
}

interface Target {
  name: string;
  pid: number;
  windowId: number;
  title?: string;
}

const LAUNCH_WAIT_MS = 4_000;

/** Starts the driver as this app's child, so the OS credits its permissions to this app. */
export function cuaDriverConnector(options: {
  command: string;
  /** The driver's own state and config, kept apart from any standalone install. */
  home: string;
}): () => Promise<CuaToolClient> {
  return async () => {
    const transport = new StdioClientTransport({
      command: options.command,
      args: ["mcp", "--direct"],
      env: {
        ...getDefaultEnvironment(),
        CUA_DRIVER_RS_HOME: options.home,
        CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
        CUA_TELEMETRY_ENABLED: "0",
        CUA_DRIVER_RS_UPDATE_CHECK: "0",
        CUA_DRIVER_DISABLE_RUN_SCRIPT: "1",
        CUA_DRIVER_DISABLE_UNRESTRICTED: "1",
      },
      stderr: "ignore",
    });
    const client = new Client({ name: "rakazo", version: "1" });
    await client.connect(transport);
    return {
      async call(name, args, signal) {
        return (await client.callTool({ name, arguments: args }, undefined, {
          signal,
          timeout: 60_000,
        })) as CuaToolResult;
      },
      close: () => client.close(),
    };
  };
}

export function createCuaHostScreen(options: CuaHostScreenOptions): HostScreen {
  let client: Promise<CuaToolClient> | undefined;
  let idle: NodeJS.Timeout | undefined;
  let active = 0;
  // The latest snapshot per window: element numbers in actions refer to it.
  const snapshots = new Map<number, string>();

  function release() {
    const current = client;
    client = undefined;
    snapshots.clear();
    void current?.then((c) => c.close()).catch(() => undefined);
  }

  async function call(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    signal.throwIfAborted();
    clearTimeout(idle);
    active += 1;
    try {
      if (!client) {
        await options.permissions();
        client = options.connect();
        client.catch(() => {
          client = undefined;
        });
      }
      let result: CuaToolResult;
      try {
        result = await (await client).call(name, args, signal);
      } catch (error) {
        if (signal.aborted || error instanceof HostScreenError) throw error;
        // A driver that crashed or hung starts fresh on the next call.
        release();
        throw new HostScreenError("Screen control stopped responding. Try again.");
      }
      if (result.isError) throw new HostScreenError(text(result) || `${name} failed`);
      return result;
    } finally {
      active -= 1;
      if (active === 0) {
        idle = setTimeout(release, options.idleMs ?? 5 * 60_000);
        idle.unref();
      }
    }
  }

  async function listApps(signal: AbortSignal): Promise<CuaApp[]> {
    const result = await call("list_apps", {}, signal);
    const apps = result.structuredContent?.apps;
    return Array.isArray(apps) ? (apps as CuaApp[]).filter((app) => app?.name) : [];
  }

  /** Only the exact name or bundle id the user approved; a near name could be another app. */
  function matchApp(apps: CuaApp[], query: string): CuaApp {
    const wanted = query.trim().toLowerCase();
    const ranked = [...apps].sort((a, b) => Number(b.running) - Number(a.running));
    const app =
      ranked.find((app) => app.name.toLowerCase() === wanted) ??
      ranked.find((app) => app.bundle_id?.toLowerCase() === wanted);
    if (app) return app;
    const near = [
      ...new Set(
        ranked.filter((app) => app.name.toLowerCase().includes(wanted)).map((app) => app.name),
      ),
    ].slice(0, 3);
    throw new HostScreenError(
      near.length
        ? `No app is named exactly "${query}". Installed apps with similar names: ${near.join(", ")}.`
        : `No app named "${query}" is installed. Ask the user for the app's exact name.`,
    );
  }

  async function frontWindow(pid: number, signal: AbortSignal): Promise<CuaWindow | undefined> {
    const result = await call("list_windows", { pid }, signal);
    const windows = (
      Array.isArray(result.structuredContent?.windows) ? result.structuredContent.windows : []
    ) as CuaWindow[];
    return windows
      .filter((window) => window.pid === pid && (window.layer ?? 0) === 0)
      .sort(
        (a, b) =>
          Number(Boolean(b.is_on_screen)) - Number(Boolean(a.is_on_screen)) ||
          (b.z_index ?? 0) - (a.z_index ?? 0),
      )[0];
  }

  async function launch(app: CuaApp, signal: AbortSignal) {
    const launched = await call(
      "launch_app",
      app.bundle_id ? { bundle_id: app.bundle_id } : { name: app.name },
      signal,
    );
    return Number(launched.structuredContent?.pid) || 0;
  }

  async function windowWithin(pid: number, ms: number, signal: AbortSignal) {
    const deadline = Date.now() + ms;
    for (;;) {
      const window = await frontWindow(pid, signal);
      if (window || Date.now() > deadline) return window;
      await sleep(400, undefined, { signal });
    }
  }

  async function target(query: string, signal: AbortSignal): Promise<Target> {
    const app = matchApp(await listApps(signal), query);
    if (app.running && app.pid === options.selfPid)
      throw new HostScreenError("Rakazo can't use its own window.");
    const pid = app.running ? app.pid : await launch(app, signal);
    if (!pid) throw new HostScreenError(`${app.name} did not open.`);
    // An app started in the background may open no window; launching it again asks it to
    // reopen one, as clicking its Dock icon does, still without bringing it to the front.
    const window =
      (await windowWithin(pid, app.running ? 0 : LAUNCH_WAIT_MS, signal)) ??
      ((await launch(app, signal)) && (await windowWithin(pid, LAUNCH_WAIT_MS, signal)));
    if (!window)
      throw new HostScreenError(
        `${app.name} is open but shows no window. Ask the user to open one, then try again.`,
      );
    return { name: app.name, pid, windowId: window.window_id, title: window.title };
  }

  async function observeTarget(
    found: Target,
    signal: AbortSignal,
    query?: string,
  ): Promise<HostScreenObservation> {
    const result = await call(
      "get_window_state",
      {
        pid: found.pid,
        window_id: found.windowId,
        max_elements: HOST_SCREEN_MAX_ELEMENTS,
        max_image_dimension: HOST_SCREEN_MAX_IMAGE_DIMENSION,
        ...(query ? { query } : {}),
      },
      signal,
    );
    const structured = result.structuredContent ?? {};
    const snapshot = typeof structured.snapshot_id === "string" ? structured.snapshot_id : "";
    if (snapshot) snapshots.set(found.windowId, snapshot);
    else snapshots.delete(found.windowId);
    const tree = boundedHostScreenTree(
      typeof structured.tree_markdown === "string" ? structured.tree_markdown : text(result),
      structured.truncated === true,
    );
    const title =
      typeof structured.window_title === "string" && structured.window_title
        ? structured.window_title
        : found.title;
    const image = result.content?.find((block) => block.type === "image" && block.data);
    const size = imageSize(structured);
    return {
      app: found.name,
      ...(title ? { title } : {}),
      tree,
      ...(image?.data && size
        ? {
            image: {
              mimeType: image.mimeType === "image/jpeg" ? "image/jpeg" : "image/png",
              data: image.data,
              ...size,
            },
          }
        : {}),
    };
  }

  function token(found: Target, element: number | undefined) {
    if (element === undefined) return undefined;
    const snapshot = snapshots.get(found.windowId);
    if (!snapshot) throw new HostScreenError(`Observe ${found.name} before using element numbers.`);
    return `${snapshot}:${element}`;
  }

  async function perform(found: Target, action: HostScreenAction, signal: AbortSignal) {
    const window = { pid: found.pid, window_id: found.windowId };
    switch (action.kind) {
      case "click": {
        const element_token = token(found, action.element);
        if (!element_token && (action.x === undefined || action.y === undefined))
          throw new HostScreenError("click needs an element or both x and y.");
        if (action.double) {
          await call(
            "double_click",
            element_token ? { element_token } : { ...window, x: action.x, y: action.y },
            signal,
          );
          return;
        }
        await call(
          "click",
          {
            ...(element_token ? { element_token } : { ...window, x: action.x, y: action.y }),
            ...(action.button === "right" ? { button: "right" } : {}),
          },
          signal,
        );
        return;
      }
      case "type": {
        const element_token = token(found, action.element);
        await call(
          "type_text",
          { pid: found.pid, text: action.text, ...(element_token ? { element_token } : {}) },
          signal,
        );
        return;
      }
      case "set":
        await call(
          "set_value",
          { element_token: token(found, action.element), value: action.value },
          signal,
        );
        return;
      case "key": {
        const element_token = token(found, action.element);
        const target = { pid: found.pid, ...(element_token ? { element_token } : {}) };
        if (action.modifiers?.length)
          await call("hotkey", { ...target, keys: [...action.modifiers, action.key] }, signal);
        else await call("press_key", { ...target, key: action.key }, signal);
        return;
      }
      case "scroll": {
        const element_token = token(found, action.element);
        const at =
          element_token !== undefined
            ? { element_token }
            : action.x !== undefined && action.y !== undefined
              ? { window_id: found.windowId, x: action.x, y: action.y }
              : {};
        await call(
          "scroll",
          { pid: found.pid, direction: action.direction, amount: action.amount ?? 3, ...at },
          signal,
        );
        return;
      }
      case "menu":
        await call("invoke_menu", { ...window, path: action.path }, signal);
        return;
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
      // Find the front window again each time: the last action may have closed the one it
      // acted on or opened another, like File > New replacing an Open panel.
      return actThenObserve(
        scope.signal,
        actions,
        async (action) => perform(await target(app, scope.signal), action, scope.signal),
        async () => observeTarget(await target(app, scope.signal), scope.signal),
      );
    },
    async close() {
      clearTimeout(idle);
      release();
    },
  };
}

function text(result: CuaToolResult) {
  return (result.content ?? [])
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function imageSize(structured: Record<string, unknown>) {
  const width = Number(structured.screenshot_width);
  const height = Number(structured.screenshot_height);
  return width > 0 && height > 0 ? { width, height } : undefined;
}
