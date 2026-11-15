import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

export const HOST_SCREEN_MAX_ACTIONS = 24;
/** Tree text the model reads per window; the driver walks at most this many elements. */
export const HOST_SCREEN_MAX_TREE_CHARS = 40_000;
export const HOST_SCREEN_MAX_ELEMENTS = 400;
/** Long screenshot edge. Larger images cost model tokens without making text easier to read. */
export const HOST_SCREEN_MAX_IMAGE_DIMENSION = 1_568;

const app = z.string().trim().min(1).max(200);
const element = z.number().int().min(0).max(100_000);
const coordinate = z.number().finite().min(0).max(20_000);

export const hostScreenAction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("click"),
    element: element.optional(),
    x: coordinate.optional(),
    y: coordinate.optional(),
    button: z.enum(["left", "right"]).optional(),
    double: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("type"), text: z.string().max(10_000), element: element.optional() }),
  z.object({ kind: z.literal("set"), element, value: z.string().max(10_000) }),
  z.object({
    kind: z.literal("key"),
    key: z.string().min(1).max(32),
    modifiers: z
      .array(z.enum(["cmd", "shift", "option", "ctrl"]))
      .max(4)
      .optional(),
    element: element.optional(),
  }),
  z.object({
    kind: z.literal("scroll"),
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().int().min(1).max(20).optional(),
    element: element.optional(),
    x: coordinate.optional(),
    y: coordinate.optional(),
  }),
  z.object({
    kind: z.literal("menu"),
    path: z.array(z.string().min(1).max(200)).min(1).max(8),
  }),
  z.object({ kind: z.literal("wait"), ms: z.number().int().min(0).max(5_000) }),
]);
export type HostScreenAction = z.infer<typeof hostScreenAction>;

export const hostScreenMethods = {
  screenObserve: { app, query: z.string().trim().min(1).max(200).optional() },
  screenAct: { app, actions: z.array(hostScreenAction).min(1).max(HOST_SCREEN_MAX_ACTIONS) },
};

/** One app window: what the model sees and the numbered elements it can act on. */
export interface HostScreenObservation {
  app: string;
  title?: string;
  /** Numbered accessibility rows; `[N]` is the element number actions take. */
  tree: string;
  /** Window-local screenshot. Click and scroll coordinates are pixels of this image. */
  image?: { mimeType: "image/png" | "image/jpeg"; data: string; width: number; height: number };
}

export interface HostScreenActResult {
  completed: number;
  /** Why the next action did not complete. Actions after it were not attempted. */
  error?: string;
  observation?: HostScreenObservation;
}

export type HostScreenScope = { botId: string; signal: AbortSignal };

/**
 * Drives apps on the person's own computer without taking their pointer, keyboard focus, or
 * front window. One implementation per platform driver; the server never sees which.
 */
export interface HostScreen {
  observe(
    scope: HostScreenScope,
    app: string,
    options?: { query?: string },
  ): Promise<HostScreenObservation>;
  act(
    scope: HostScreenScope,
    app: string,
    actions: readonly HostScreenAction[],
  ): Promise<HostScreenActResult>;
  close(): Promise<void>;
}

/** A message written for the bot. It reveals nothing beyond the person's own screen. */
export class HostScreenError extends Error {
  constructor(message: string) {
    super(message.length > 500 ? `${message.slice(0, 500)}…` : message);
    this.name = "HostScreenError";
  }
}

/** Caps the tree the model reads and says when rows were left out. */
export function boundedHostScreenTree(tree: string, truncated: boolean): string {
  const bounded =
    tree.length > HOST_SCREEN_MAX_TREE_CHARS
      ? `${tree.slice(0, HOST_SCREEN_MAX_TREE_CHARS)}\n…`
      : tree;
  return truncated || bounded.endsWith("…")
    ? `${bounded}\nSome rows were cut off. Observe again with a query to find the rest.`
    : bounded;
}

/**
 * Runs actions in order until one is refused, then looks at the window. Actions that ran stay
 * counted even when that look fails, so the bot never repeats them blindly.
 */
export async function actThenObserve(
  signal: AbortSignal,
  actions: readonly HostScreenAction[],
  perform: (action: HostScreenAction) => Promise<void>,
  observe: () => Promise<HostScreenObservation>,
): Promise<HostScreenActResult> {
  let completed = 0;
  let error: string | undefined;
  for (const action of actions) {
    try {
      await perform(action);
    } catch (caught) {
      if (!(caught instanceof HostScreenError)) throw caught;
      error = caught.message;
      break;
    }
    completed += 1;
  }
  // Let the app redraw before the look that shows the result.
  await sleep(300, undefined, { signal });
  try {
    return { completed, ...(error ? { error } : {}), observation: await observe() };
  } catch (caught) {
    if (!(caught instanceof HostScreenError)) throw caught;
    return { completed, error: error ?? caught.message };
  }
}
