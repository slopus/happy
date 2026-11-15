/** How long a bot's screen action waits for a person to hand the screen back. */
export const SCREEN_WAIT_MS = 45_000;
const SCREEN_POLL_MS = 1_000;

export const PERSON_HAS_CONTROL =
  "A person has control of the screen, so this was not performed. File and shell tools still work.";
export const PERSON_HANDED_BACK =
  "A person used the screen and handed it back, so this was not performed. Take a fresh screenshot before continuing.";

/** What one attempt knows about people using its screen between its own actions. */
export interface ScreenTurn {
  /** The computer's control generation when this attempt last used the screen. */
  controlFence: number | undefined;
  /** A person used the screen since this attempt last saw it. */
  mustLook: boolean;
}

export interface ScreenControl {
  /** A person holds control of this bot's screen now. */
  held: boolean;
  /** Counts every time a person took control of this computer. */
  fence: number;
}

/**
 * Decide whether a bot's screen tool may run. A person's control is waited out briefly and then
 * refused, never queued, and an action that waited or follows a person's use is refused too, so
 * the bot looks again before acting on a screen a person just changed.
 */
export async function awaitScreenTurn(input: {
  turn: ScreenTurn;
  /** Looking (a screenshot or snapshot) is how the bot catches up, so it is never refused for that. */
  look: boolean;
  readControl: () => Promise<ScreenControl | null>;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  waitMs?: number;
}): Promise<string | undefined> {
  const { turn } = input;
  const now = input.now ?? Date.now;
  const deadline = now() + (input.waitMs ?? SCREEN_WAIT_MS);
  let control = await input.readControl();
  while (control?.held) {
    turn.mustLook = true;
    const left = deadline - now();
    if (left <= 0) return PERSON_HAS_CONTROL;
    await input.sleep(Math.min(SCREEN_POLL_MS, left));
    control = await input.readControl();
  }
  // On a shared Team computer a person taking another bot's screen also moves the fence; that
  // costs this bot one extra look, never a wait.
  if (control && turn.controlFence !== undefined && control.fence !== turn.controlFence) {
    turn.mustLook = true;
  }
  if (control) turn.controlFence = control.fence;
  // A look runs, and clears mustLook only once it returns the screen.
  if (!turn.mustLook || input.look) return undefined;
  return PERSON_HANDED_BACK;
}
