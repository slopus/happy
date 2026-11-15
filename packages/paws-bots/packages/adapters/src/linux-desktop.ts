import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type {
  AdapterContext,
  CommandRequest,
  ComputerAction,
  ComputerActionRequest,
  ComputerInput,
  ComputerRef,
  PageBrowserCommand,
  PageBrowserResult,
  ScreenRequest,
  ScreenSession,
  TerminalRequest,
} from "@rakazo/adapter-kit";
import type { DesktopEnvironment } from "@rakazo/core/node/desktop-runtime";
import {
  BROWSER_APPLICATIONS,
  BROWSER_STILL_RUNNING_EXIT,
  browserLauncherPath,
  browserProfilePathForScreen,
  desktopControlCommand,
  desktopTerminalCommand,
  desktopUrl,
  desktopWorkCommand,
  managedDesktopCommand,
  releaseDesktopCommand,
  screenDisplayArgv,
  screenPorts,
  shellQuote,
  stopAllDesktopBrowsersCommand,
} from "@rakazo/core/node/desktop-runtime";
import {
  BrowserStillRunningError,
  BrowserStoppedReleaseError,
  ComputerScreenUnavailableError,
  screenSessionKey,
} from "./computer-screens.js";
import {
  boundedComputerActions,
  clampRounded,
  computerObservation,
  workspacePath,
} from "./computer-support.js";
import {
  extraDisplayActionCommand,
  extraDisplayInputCommand,
  observeExtraDisplayCommand,
  parseExtraDisplayObservation,
} from "./extra-displays.js";

export interface LinuxDesktopHost {
  environment(computer: ComputerRef, context: AdapterContext): Promise<DesktopEnvironment>;
  run(
    computer: ComputerRef,
    command: string,
    context: AdapterContext,
  ): Promise<{ code: number; stdout: string; stderr?: string }>;
  screenUrl(computer: ComputerRef, port: number, context: AdapterContext): Promise<string>;
  /**
   * Runs a command with `input` on its stdin, never in its command line, which other processes
   * and the provider's logs can read. Providers with the page browser installed implement it.
   */
  runWithInput?(
    computer: ComputerRef,
    command: string,
    input: string,
    timeoutMs: number,
    context: AdapterContext,
  ): Promise<{ code: number; stdout: string }>;
}

/** The supervisor's limit on one page-browser call, which the helper's own waits fit inside. */
const PAGE_BROWSER_TIMEOUT_MS = 25_000;
const PAGE_BROWSER_MAX_OUTPUT = 512 * 1024;

/** Point a bot's commands at its own screen, as Docker computers do, unless the caller chose a display. */
export function onBotScreen(
  request: CommandRequest,
  context: AdapterContext,
  displayStart: number,
): CommandRequest {
  if (
    !context.botId ||
    !request.argv.length ||
    Object.hasOwn(request.env ?? {}, "DISPLAY") ||
    request.unsetEnv?.includes("DISPLAY")
  )
    return request;
  return {
    ...request,
    argv: screenDisplayArgv(request.argv, screenSessionKey(context), displayStart),
  };
}

/** Provider SDKs supply only command execution, workspace paths, and protected port URLs. */
export class LinuxDesktop {
  constructor(private readonly host: LinuxDesktopHost) {}

  private async run(computer: ComputerRef, command: string, context: AdapterContext) {
    context.signal.throwIfAborted();
    const result = await this.host.run(computer, command, context);
    if (result.code === 75) throw new ComputerScreenUnavailableError();
    if (result.code === BROWSER_STILL_RUNNING_EXIT) throw new BrowserStillRunningError();
    if (result.code !== 0) {
      if (result.stderr?.trim()) throw new Error(result.stderr);
      const output = result.stdout.trim().split("\n").at(-1)?.slice(0, 300);
      throw new Error("computer desktop operation failed", {
        cause: new Error(output ? `exit ${result.code}: ${output}` : `exit ${result.code}`),
      });
    }
    return result.stdout;
  }

  private async ensure(computer: ComputerRef, context: AdapterContext) {
    const env = await this.host.environment(computer, context);
    const key = screenSessionKey(context);
    const output = await this.run(
      computer,
      managedDesktopCommand(key, context.screenLeaseId, env, randomUUID()),
      context,
    );
    const match = output.match(/RAKAZO_DESKTOP=(\d+):([a-zA-Z0-9_-]+)/);
    if (!match) throw new ComputerScreenUnavailableError();
    const index = Number(match[1]);
    const ports = screenPorts(index, env);
    const layout = {
      ...ports,
      viewPort: Number(ports.viewPort),
      controlPort: Number(ports.controlPort),
    };
    return { env, key, layout, token: match[2]! };
  }

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    const screen = await this.ensure(computer, context);
    let token = screen.token;
    if (request.interactive) {
      if (!request.controlToken) throw new Error("interactive screen requires a control token");
      token = request.controlToken;
      await this.run(
        computer,
        desktopControlCommand(screen.key, context.screenLeaseId, screen.env, true, token),
        context,
      );
    }
    const url = await this.host.screenUrl(
      computer,
      request.interactive ? screen.layout.controlPort : screen.layout.viewPort,
      context,
    );
    return { url: desktopUrl(url, token), mimeType: "text/html", close: async () => undefined };
  }

  async connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    const screen = await this.ensure(computer, context);
    const terminalToken = randomUUID();
    await this.run(
      computer,
      desktopTerminalCommand(
        screen.key,
        context.screenLeaseId,
        screen.env,
        request.controlToken,
        terminalToken,
        workspacePath(screen.env.workspaceDir, request.cwd ?? ""),
      ),
      context,
    );
    const url = await this.host.screenUrl(computer, screen.layout.controlPort, context);
    return { url: desktopUrl(url, terminalToken) };
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    token?: string,
  ) {
    if (!token) {
      if (interactive) throw new Error("interactive screen requires a control token");
      return;
    }
    const env = interactive
      ? (await this.ensure(computer, context)).env
      : await this.host.environment(computer, context);
    await this.run(
      computer,
      desktopControlCommand(
        screenSessionKey(context),
        context.screenLeaseId,
        env,
        interactive,
        token,
      ),
      context,
    );
  }

  async observe(computer: ComputerRef, context: AdapterContext) {
    const { layout } = await this.ensure(computer, context);
    return this.observeLayout(computer, layout, context);
  }

  private async observeLayout(
    computer: ComputerRef,
    layout: { display: string; displayNumber: number },
    context: AdapterContext,
  ) {
    const output = await this.run(computer, observeExtraDisplayCommand(layout), context);
    const observed = parseExtraDisplayObservation(output);
    return computerObservation(observed.image, {
      mimeType: "image/png",
      width: 1280,
      height: 800,
      cursor: observed.cursor,
    });
  }

  async sendInput(computer: ComputerRef, input: ComputerInput, context: AdapterContext) {
    const { layout } = await this.ensure(computer, context);
    await this.run(computer, extraDisplayInputCommand(layout, input), context);
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    const { layout, env, key } = await this.ensure(computer, context);
    let completed = 0;
    for (const action of boundedComputerActions(request.actions)) {
      await this.run(
        computer,
        `export CHROME_USER_DATA_DIR=${shellQuote(browserProfilePathForScreen(key, env))} BROWSER=${browserLauncherPath(layout.displayNumber)}\n${browserActionCommand(action, layout, env)}`,
        context,
      );
      completed += 1;
    }
    if (request.settleMs)
      await this.run(computer, `sleep ${clampRounded(request.settleMs, 0, 5000) / 1000}`, context);
    return {
      completed,
      ...(request.observe === false
        ? {}
        : { observation: await this.observeLayout(computer, layout, context) }),
    };
  }

  /** The page tools on this screen's Chrome, through the computer image's helper. */
  async pageBrowser(
    computer: ComputerRef,
    request: PageBrowserCommand,
    context: AdapterContext,
  ): Promise<PageBrowserResult> {
    if (!this.host.runWithInput) throw new Error("This computer has no page browser.");
    const { layout, env, key } = await this.ensure(computer, context);
    const result = await this.host.runWithInput(
      computer,
      desktopWorkCommand(
        key,
        context.screenLeaseId,
        layout.displayNumber - env.displayStart,
        [
          `DISPLAY=${layout.display}`,
          `RAKAZO_CDP_PORT=${layout.debugPort}`,
          // Uploads are confined to the bot's home, which is the workspace here.
          `HOME=${shellQuote(env.workspaceDir)}`,
          "RAKAZO_BROWSER_ARGS_STDIN=1",
          "/usr/local/bin/rakazo-page-browser",
          request.command,
        ].join(" "),
      ),
      // Origin-bound fills carry saved logins and cards.
      `${JSON.stringify(request)}\n`,
      PAGE_BROWSER_TIMEOUT_MS,
      context,
    );
    if (result.code === 124) {
      throw new Error(
        `Page browser timed out; the page may be busy or blocked by a dialog. ${
          request.command === "act"
            ? "Inspect the screen before continuing."
            : "Retry once before using other tools."
        }`,
      );
    }
    if (Buffer.byteLength(result.stdout) > PAGE_BROWSER_MAX_OUTPUT)
      throw new Error("Page browser unavailable or interrupted");
    // Exit 2 is the page browser refusing the command before touching the page (an older
    // computer image does not know it). Pass its reply on, so a caller can tell "cannot
    // check" from a check that failed.
    if (result.code === 2) {
      const refused = refusedCommand(result.stdout);
      if (refused) return refused;
    }
    if (result.code !== 0) throw new Error("Page browser unavailable or interrupted");
    return JSON.parse(result.stdout) as PageBrowserResult;
  }

  async stopBrowsers(computer: ComputerRef, context: AdapterContext) {
    const env = await this.host.environment(computer, context);
    await this.run(computer, stopAllDesktopBrowsersCommand(env), context);
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext) {
    const env = await this.host.environment(computer, context);
    const key = screenSessionKey(context);
    if (context.keepScreenWarm && !context.cancelRunWork && !context.signal.aborted) {
      // Revoke the run's control and keep the display and browser for this bot's next run.
      // A stale fence (75) is already someone else's screen. If revocation is uncertain,
      // fall through to full teardown rather than retaining control.
      const control = await this.host
        .run(computer, desktopControlCommand(key, context.screenLeaseId, env, false), context)
        .catch(() => undefined);
      if (control?.code === 0 || control?.code === 75) return;
    }
    // A stale release is a successful no-op. A failed stop must retain the slot
    // for retry. Once the browser has stopped, a later slot-cleanup error must
    // not look like Chromium is still running.
    const result = await this.host.run(
      computer,
      releaseDesktopCommand(key, context.screenLeaseId, env),
      context,
    );
    if (result.stdout.includes("RAKAZO_DESKTOP_RELEASED=")) {
      if (result.code !== 0 && result.code !== 75) throw new BrowserStoppedReleaseError();
      return;
    }
    if (result.code !== 0 && result.code !== 75)
      throw new Error(result.stderr || "computer desktop failed to stop");
  }
}

function browserActionCommand(
  action: ComputerAction,
  layout: Parameters<typeof extraDisplayActionCommand>[0],
  env: DesktopEnvironment,
) {
  if (action.kind === "focus") {
    const command = focusOrLaunchActionCommand(action, layout);
    // The browser launcher is absolute. Other apps and URIs are workspace-relative,
    // same as the launch path below.
    if (isChromiumBrowser(action.application)) return command;
    return `cd ${shellQuote(env.workspaceDir)}\n${command}`;
  }
  const workspace = env.workspaceDir;
  const file =
    action.kind === "open" && !/^https?:\/\//i.test(action.path)
      ? workspacePath(workspace, action.path)
      : undefined;
  const browser =
    file !== undefined
      ? pathToFileURL(file, { windows: false }).href
      : action.kind === "open"
        ? action.path
        : action.kind === "launch" && BROWSER_APPLICATIONS.has(action.application.toLowerCase())
          ? (action.uri ?? "about:blank")
          : undefined;
  if (browser !== undefined) {
    // A workspace file is a tab in this screen's browser, as on Docker computers. xdg-open
    // ran the image's viewer in the foreground and held the action until the command timeout.
    const exists =
      file === undefined
        ? ""
        : `[ -e ${shellQuote(file)} ] || { echo ${shellQuote(`file '${file}' does not exist`)} >&2; exit 2; }\n`;
    return `${exists}nohup ${browserLauncherPath(layout.displayNumber)} ${shellQuote(browser)} </dev/null >/tmp/rakazo/browser-open-${layout.displayNumber}.log 2>&1 &`;
  }
  return `cd ${shellQuote(workspace)}\n${extraDisplayActionCommand(layout, action)}`;
}

// Chrome-family WM_CLASS components. Matched whole, so "xterm" does not raise "uxterm".
const CHROME_WM_CLASSES =
  "chromium|chromium-browser|google-chrome|google-chrome-stable|chrome|brave-browser";

// Launch maps every BROWSER_APPLICATIONS name, including firefox, onto the
// Chromium launcher. Focus must use that same set or it cannot raise the window launch opened.
function isChromiumBrowser(application: string) {
  return BROWSER_APPLICATIONS.has(application.toLowerCase());
}

// Same 0.2s quick-failure window as rakazo-focus-or-launch. A GUI that stays
// up is success; an immediate non-zero exit fails the focus before the old
// window is raised or a new one is awaited.
const FOCUS_LAUNCH_PROBE = [
  "import subprocess,sys",
  "try:",
  " code=subprocess.Popen(sys.argv[1:],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).wait(timeout=0.2)",
  "except subprocess.TimeoutExpired:",
  " raise SystemExit(0)",
  "raise SystemExit(code)",
].join("\n");

/**
 * Raise an app's existing window by WM_CLASS, else spawn it — the focus primitive
 * rakazo-focus-or-launch provides inside the computer image, inline for provider desktops.
 * A URI still starts the launcher (Chrome forwards URLs into its live window) without
 * waiting for that process to exit before the match is raised.
 */
function focusOrLaunchActionCommand(
  action: Extract<ComputerAction, { kind: "focus" }>,
  layout: Parameters<typeof extraDisplayActionCommand>[0],
) {
  const browser = isChromiumBrowser(action.application);
  const binary = (action.application.split("/").pop() ?? "").replaceAll(/[^A-Za-z0-9_-]/g, "");
  const quotedApp = shellQuote(action.application);
  const quotedArg = action.uri === undefined ? "" : ` ${shellQuote(action.uri)}`;
  // Like rakazo-focus-or-launch, the launch never adopts the app's lifetime: a GUI that stays
  // up must not hold the command open, and one that exits at once with an error still fails.
  const launch = browser
    ? `nohup ${browserLauncherPath(layout.displayNumber)} ${shellQuote(action.uri ?? "about:blank")} </dev/null >/tmp/rakazo/browser-open-${layout.displayNumber}.log 2>&1 &`
    : `DISPLAY=${layout.display} python3 -c ${shellQuote(FOCUS_LAUNCH_PROBE)} ${quotedApp}${quotedArg} || exit $?`;
  if (!browser && !binary) return launch;
  const classCase = browser ? CHROME_WM_CLASSES : binary.toLowerCase();
  return [
    "wid=",
    "fallback=",
    "saw_profile=0",
    "while read -r id desktop pid class _; do",
    '  [ -n "$id" ] || continue',
    "  class_lc=$(printf '%s' \"$class\" | tr '[:upper:]' '[:lower:]')",
    "  old_ifs=$IFS",
    "  IFS=.",
    "  set -f",
    "  matched=0",
    "  for part in $class_lc; do",
    `    case "$part" in ${classCase}) matched=1 ;; esac`,
    "  done",
    "  set +f",
    "  IFS=$old_ifs",
    '  [ "$matched" -eq 1 ] || continue',
    '  [ -z "$fallback" ] && fallback=$id',
    // Several Chrome profiles can share a display. Prefer the screen profile when
    // a window advertises --user-data-dir; otherwise keep the first class match.
    ...(browser
      ? [
          '  if [ -n "$CHROME_USER_DATA_DIR" ]; then',
          '    case "$pid" in',
          "      ''|*[!0-9]*) owner=\"\" ;;",
          "      *) owner=$(tr '\\0' '\\n' <\"/proc/$pid/cmdline\" 2>/dev/null | awk 'prev == \"--user-data-dir\" { print; exit } index($0, \"--user-data-dir=\") == 1 { print substr($0, 17); exit } { prev = $0 }') ;;",
          "    esac",
          '    if [ -n "$owner" ]; then',
          "      saw_profile=1",
          '      if [ "$owner" = "$CHROME_USER_DATA_DIR" ]; then wid=$id; break; fi',
          "      continue",
          "    fi",
          "  fi",
        ]
      : ["  wid=$id", "  break"]),
    "done <<RAKAZO_WINDOWS",
    `$(DISPLAY=${layout.display} wmctrl -lxp 2>/dev/null || true)`,
    "RAKAZO_WINDOWS",
    'if [ -z "$wid" ] && [ "$saw_profile" -eq 0 ]; then wid=$fallback; fi',
    'if [ -n "$wid" ]; then',
    ...(action.uri !== undefined ? [`  ${launch}`] : []),
    `  DISPLAY=${layout.display} wmctrl -ia "$wid"`,
    "else",
    `  ${launch}`,
    "fi",
  ].join("\n");
}

/** Install the same X11 tools in minimal Ubuntu sandboxes, only if their image lacks them. */
const FIND_MISSING_DESKTOP_TOOLS = [
  'missing=""',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
  'for pair in python3:python3 flock:util-linux Xvfb:xvfb xdpyinfo:x11-utils x11vnc:x11vnc fluxbox:fluxbox xdotool:xdotool wmctrl:wmctrl scrot:scrot xterm:xterm; do command -v "${pair%%:*}" >/dev/null 2>&1 || missing="$missing ${pair#*:}"; done',
  'if ! command -v websockify >/dev/null 2>&1 && [ ! -x /opt/noVNC/utils/websockify/run ]; then missing="$missing websockify"; fi',
  'if [ ! -d /usr/share/novnc ] && [ ! -d /opt/noVNC ]; then missing="$missing novnc"; fi',
];

/**
 * Same as infra/sandboxes/computer/browser-policy.json. Rakazo keeps credentials itself, so
 * the browser's save-password, address, and card prompts only cover the page. Pop-ups open: a
 * page that opens a report once it has made it is past the click's user activation, and the
 * pop-up blocker would drop it without a sign the page tools can see. Only the hosted sandboxes
 * that are the bot's own computer are prepared with it, never the person's own computer.
 */
export const BROWSER_POLICY = JSON.stringify({
  PasswordManagerEnabled: false,
  AutofillAddressEnabled: false,
  AutofillCreditCardEnabled: false,
  DefaultPopupsSetting: 1,
});

/** Managed policy directories for Chromium, Ubuntu's Chromium, Google Chrome, and Brave. */
const BROWSER_POLICY_DIRS = [
  "/etc/chromium/policies/managed",
  "/etc/chromium-browser/policies/managed",
  "/etc/opt/chrome/policies/managed",
  "/etc/brave/policies/managed",
];

export const PREPARE_LINUX_DESKTOP = [
  "set -eu",
  ...FIND_MISSING_DESKTOP_TOOLS,
  'if [ "$(id -u)" -eq 0 ]; then root=""; else root="sudo -n"; fi',
  'if [ -n "$missing" ]; then',
  // Separate commands: set -e ignores a failure on the left of &&.
  "  $root apt-get update -qq",
  "  if ! $root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-remove $missing; then",
  // Provider images can arrive with unrelated, unfinished package dependencies. Let APT
  // solve those without specifying the desktop packages, and never remove existing tools.
  "    $root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --fix-broken --no-remove",
  "    $root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-remove $missing",
  "  fi",
  "fi",
  // Bots read pages visually; without a color emoji font every emoji is an empty box. The
  // desktop works without it, so an image whose package manager is broken still runs.
  "if [ ! -e /usr/share/fonts/truetype/noto/NotoColorEmoji.ttf ]; then",
  '  { $root apt-get update -qq && $root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fonts-noto-color-emoji; } || echo "could not install the emoji font" >&2',
  "fi",
  `policy=${shellQuote(BROWSER_POLICY)}`,
  `for dir in ${BROWSER_POLICY_DIRS.join(" ")}; do`,
  '  [ "$(cat "$dir/rakazo-browser.json" 2>/dev/null)" = "$policy" ] && continue',
  // A sandbox without root keeps working; its browser just shows the prompts.
  '  printf \'%s\\n\' "$policy" | $root sh -c \'mkdir -p "$1" && cat > "$1/rakazo-browser.json"\' sh "$dir" || echo "could not set browser policy in $dir" >&2',
  "done",
].join("\n");

/** Installs Google Chrome on images that ship without a browser. */
export const INSTALL_LINUX_BROWSER = [
  "if ! command -v google-chrome >/dev/null && ! command -v chromium >/dev/null; then",
  '  if [ "$(id -u)" -eq 0 ]; then root=""; else root="sudo -n"; fi',
  "  package=$(mktemp /tmp/rakazo-chrome-XXXXXX.deb)",
  "  trap 'rm -f \"$package\"' EXIT",
  '  curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o "$package"',
  '  $root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$package"',
  "fi",
].join("\n");

/** Fails unless every desktop tool is installed and a virtual display answers. */
export const VERIFY_LINUX_DESKTOP = [
  "set -eu",
  ...FIND_MISSING_DESKTOP_TOOLS,
  'if [ -n "$missing" ]; then echo "missing desktop tools:$missing" >&2; exit 1; fi',
  "Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &",
  "xvfb=$!",
  "ready=0",
  "for _ in $(seq 50); do",
  "  if xdpyinfo -display :99 >/dev/null 2>&1; then ready=1; break; fi",
  "  sleep 0.1",
  "done",
  'kill "$xvfb" 2>/dev/null || true',
  'wait "$xvfb" 2>/dev/null || true',
  'if [ "$ready" -ne 1 ]; then echo "Xvfb did not start" >&2; exit 1; fi',
].join("\n");

/** The page browser's own reply when it refused a command, or nothing when the output is not one. */
function refusedCommand(stdout: string): PageBrowserResult | undefined {
  try {
    const reply = JSON.parse(stdout) as { ok?: unknown; error?: unknown };
    return reply && reply.ok === false && typeof reply.error === "string"
      ? (reply as PageBrowserResult)
      : undefined;
  } catch {
    return undefined;
  }
}
