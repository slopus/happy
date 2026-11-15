/**
 * `unsupported` covers an unpackaged build and a repository with no published releases, which is
 * the normal state for a fork. It is not an error the user needs to act on. Automatic checks stay
 * frozen after an empty feed; a manual check may retry when the install itself supports updates.
 */
export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "unsupported"
  | "error";

export interface DesktopUpdateState {
  phase: DesktopUpdatePhase;
  /** The installed desktop release, which can drift from the server this app points at. */
  currentVersion: string;
  availableVersion: string | null;
  /** Download progress 0-100, only while `downloading`. */
  percent: number | null;
  message: string | null;
  checkedAt: string | null;
}

export interface RakazoDesktopUpdate {
  state: () => Promise<DesktopUpdateState>;
  check: () => Promise<DesktopUpdateState>;
  download: () => Promise<DesktopUpdateState>;
  /** Quits and relaunches into the downloaded release; only useful once `phase` is `ready`. */
  install: () => Promise<DesktopUpdateState>;
}

export interface RakazoDesktopOAuthCallback {
  code: string;
  state?: string;
}

export interface RakazoDesktopDevice {
  /** Null until paired. */
  deviceId: string | null;
  name: string;
  allowed: boolean;
}

/**
 * What the system recognizer reports for one listening session, shaped after Web Speech:
 * `result` carries the session's whole text so far, `error` a Web Speech error code,
 * and `end` always comes last.
 */
export type RakazoDesktopSpeechEvent =
  | { session: number; type: "result"; text: string }
  | { session: number; type: "error"; error: string }
  | { session: number; type: "end" };

/** App menu items the page carries out; each matches a shortcut the page also handles itself. */
export const DESKTOP_MENU_COMMANDS = [
  "new",
  "command-menu",
  "search",
  "toggle-sidebar",
  "back",
  "forward",
  "next-bot",
  "previous-bot",
  "new-group",
  "integrations",
  "chat-panel",
  "shortcuts",
  "find",
] as const;

export type DesktopMenuCommand = (typeof DESKTOP_MENU_COMMANDS)[number];

export function isDesktopMenuCommand(value: unknown): value is DesktopMenuCommand {
  return (DESKTOP_MENU_COMMANDS as readonly unknown[]).includes(value);
}

export interface RakazoDesktop {
  /** Optional for older desktop releases. Returns false when the native write is refused. */
  clipboard?: {
    writeText: (text: string) => Promise<boolean>;
  };
  /** Optional for compatibility with older desktop releases. */
  badge?: {
    set: (count: number) => Promise<boolean>;
  };
  computer?: {
    /** Native main persists host choice through its local capability, never a user session. */
    managesHostChoice?: boolean;
    requestAccess: () => Promise<boolean>;
    revokeAccess: () => Promise<void>;
    onConfigure: (listener: () => void) => () => void;
  };
  /** Optional for compatibility with older desktop releases. */
  device?: {
    /** Null when the app shows its own local server. */
    state: () => Promise<RakazoDesktopDevice | null>;
    /** Turning it on asks with a native prompt the page cannot answer. */
    setAllowed: (allowed: boolean) => Promise<RakazoDesktopDevice | null>;
  };
  /** Absent on older desktop releases, whose menus carry no app commands. */
  menu?: {
    onCommand: (listener: (command: DesktopMenuCommand) => void) => () => void;
  };
  /** False for local builds, whose errors must not reach production reporting. Absent on older releases. */
  monitoring?: {
    enabled: () => Promise<boolean>;
  };
  /** Optional for compatibility with older desktop releases. */
  locale?: {
    /** The language the page shows, so the app's own menus, dialogs and setup window follow it. */
    set: (locale: string) => Promise<void>;
  };
  /** Optional for compatibility with older desktop releases. */
  passkeys?: {
    /** Relying parties this build is associated with for system passkeys (macOS); others fail. */
    rpIds: () => Promise<string[]>;
  };
  /** Absent on older desktop releases. */
  server?: {
    /** Opens the desktop setup window to pick another Rakazo server. */
    change: () => Promise<void>;
  };
  /** Absent on older desktop releases, which have no Settings… menu item. */
  settings?: {
    /** The app menu's Settings… item; the OS claims Cmd+, before any page keydown can. */
    onOpen: (listener: () => void) => () => void;
  };
  /**
   * The operating system's own speech recognition, so dictation needs no provider key.
   * Absent on platforms without one and on older desktop releases.
   */
  speech?: {
    /** Listens in `language` until stopped. False when refused; no events follow then. */
    start: (language: string, session: number) => Promise<boolean>;
    /** Ends the utterance: its final text and `end` still arrive. */
    stop: (session: number) => Promise<void>;
    abort: (session: number) => Promise<void>;
    onEvent: (listener: (event: RakazoDesktopSpeechEvent) => void) => () => void;
  };
  platform: string;
  /** Absent on older frameless releases, which still need in-app controls. */
  nativeWindowFrame?: boolean;
  window: {
    close: () => Promise<void>;
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    state: () => Promise<{ minimized: boolean; maximized: boolean; fullScreen: boolean }>;
  };
  update: RakazoDesktopUpdate;
  oauth: {
    /**
     * Open system-browser auth. A redirect_uri must be HTTP loopback with state;
     * URLs without a redirect use backend polling. Optional for older desktops.
     */
    open?: (authorizationUrl: string) => Promise<void>;
    cancel?: (authorizationUrl: string) => Promise<void>;
    /**
     * Authorization codes captured from the system browser or a legacy popup.
     * Returns an unsubscribe function.
     */
    onCallback: (listener: (callback: RakazoDesktopOAuthCallback) => void) => () => void;
  };
}

/**
 * How the desktop app was pointed at a Rakazo server during first-run setup.
 * `new` is the Docker Compose stack this app installs and runs on the same computer.
 */
export type DesktopInstanceMode = "new" | "existing";

export interface DesktopSetup {
  mode: DesktopInstanceMode;
  serverUrl: string;
  /** Sent with every request to an existing server, such as an access proxy's credentials. */
  headers?: Record<string, string>;
}

export interface DesktopSetupState {
  defaultLocalUrl: string;
  /** Hosted Rakazo origin, saved as an `existing` server when chosen. */
  cloudUrl: string;
  saved: DesktopSetup | null;
  /** Present when a saved or newly selected server could not be reopened. */
  error?: string;
}

export interface DesktopReachability {
  ok: boolean;
  /** HTTP status when the server answered, absent when it could not be reached. */
  status?: number;
  /** Normalized URL that was probed, absent when the input was not a usable URL. */
  url?: string;
  error?: string;
}

export interface DesktopStackProbeResponse {
  ok: true;
  imageTag: string;
}

/**
 * Lifecycle of the Docker Compose stack the desktop app manages for mode `new`.
 * `docker-missing` and `docker-not-running` wait for the person to act; `ready` and
 * `failed` are terminal until the next start.
 */
export type DesktopLocalStackPhase =
  | "idle"
  | "checking-docker"
  | "docker-missing"
  | "docker-not-running"
  | "preparing"
  | "pulling"
  | "starting"
  | "waiting-healthy"
  | "ready"
  | "failed";

export interface DesktopLocalStackState {
  phase: DesktopLocalStackPhase;
  /** One actionable sentence; null while the stack is progressing normally. */
  message: string | null;
  /** Bounded tail of docker output for the current attempt. */
  output: string[];
  /** Bytes pulled per image layer in the current attempt; the sum is the only progress Docker reports. */
  layerBytes: Record<string, number>;
  /** Image tag this app launches (`v<app version>` for installed builds, `edge` otherwise). */
  imageTag: string;
}

/** The official Docker download for this platform (an installer, or Linux install docs). */
export type DesktopSetupLink = "docker-download";

/**
 * Bridge exposed only to the first-run setup window. The app window keeps the
 * narrower `rakazoDesktop` bridge so a connected server can never re-point the app.
 */
export interface RakazoSetup {
  /** Used only to reserve space for native window controls in the local setup UI. */
  platform: string;
  /** The page's language and its translations, keyed by the English text; empty for English. */
  locale: { lang: string; dir: "ltr" | "rtl"; messages: Readonly<Record<string, string>> };
  state: () => Promise<DesktopSetupState>;
  test: (url: string, headers?: Record<string, string>) => Promise<DesktopReachability>;
  save: (setup: DesktopSetup) => Promise<{ ok: boolean; error?: string }>;
  quit: () => Promise<void>;
  /** Opens the Docker download in the system browser; the person runs the installer. */
  openLink: (link: DesktopSetupLink) => Promise<void>;
  /** The Docker Compose stack this app installs and runs for mode `new`. */
  stack: {
    state: () => Promise<DesktopLocalStackState>;
    /** Starts (or retries) the stack; a no-op while a start is already in flight. */
    start: () => Promise<DesktopLocalStackState>;
    /** Fires on every state change so progress never depends on a renderer timer. */
    onChange: (listener: (state: DesktopLocalStackState) => void) => void;
  };
}
