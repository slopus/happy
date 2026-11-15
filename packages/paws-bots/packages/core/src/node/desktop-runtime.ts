import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
import path from "node:path";
import { TERMINAL_SERVER_PROGRAM } from "./terminal-server.js";
// Each live Chrome needs a private debugger port. This is the TCP address-space
// boundary, not a product limit on bots or saved browser profiles.
export const MAX_DESKTOP_DISPLAY = 65535 - 9221;
export const BROWSER_APPLICATIONS = new Set([
  "brave",
  "brave-browser",
  "browser",
  "chrome",
  "chromium",
  "chromium-browser",
  "firefox",
  "google-chrome",
  "google-chrome-stable",
  "rakazo-browser",
]);
export interface DesktopEnvironment {
  homeDir: string;
  workspaceDir: string;
  browserProfilesDir: string;
  displayStart: number;
  preservePrimaryDisplay?: boolean;
  portStart?: number;
  bindHost?: string;
}
export const DEFAULT_DESKTOP_ENV: DesktopEnvironment = {
  homeDir: "/home/rakazo",
  workspaceDir: "/home/rakazo",
  browserProfilesDir: "/home/rakazo/.browser-profiles",
  displayStart: 1,
  bindHost: "127.0.0.1",
  preservePrimaryDisplay: true,
};
/** Rebuildable tool caches live outside the saved home. Tools create these under /tmp. */
export const COMPUTER_CACHE_ENV = {
  XDG_CACHE_HOME: "/tmp/rakazo-cache/xdg",
  npm_config_cache: "/tmp/rakazo-cache/npm",
  PIP_CACHE_DIR: "/tmp/rakazo-cache/pip",
  PLAYWRIGHT_BROWSERS_PATH: "/tmp/rakazo-cache/ms-playwright",
  UV_CACHE_DIR: "/tmp/rakazo-cache/uv",
};

function gatewayHost(host = "127.0.0.1") {
  if (host !== "localhost" && host !== "::" && !isIPv4(host))
    throw new Error("invalid screen gateway bind host");
  return host;
}

function gatewayProbeHost(host: string) {
  return host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
}

export function screenPorts(index: number, env = DEFAULT_DESKTOP_ENV) {
  if (!Number.isSafeInteger(index) || index < 0 || index + env.displayStart > MAX_DESKTOP_DISPLAY)
    throw new Error("invalid desktop index");
  const displayNumber = env.displayStart + index;
  return {
    display: `:${displayNumber}`,
    displayNumber,
    bindHost: gatewayHost(env.bindHost),
    viewPort: String(env.portStart ?? 6080),
    controlPort: String(env.portStart ?? 6080),
    debugPort: 9221 + displayNumber,
  };
}

function commandLayout(index: number | undefined, env: DesktopEnvironment) {
  if (index !== undefined) return screenPorts(index, env);
  return {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    display: ":${desktop_display}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    displayNumber: "${desktop_display}",
    bindHost: gatewayHost(env.bindHost),
    viewPort: String(env.portStart ?? 6080),
    controlPort: String(env.portStart ?? 6080),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    debugPort: "${desktop_debug}",
  };
}

type DesktopLayout = Omit<ReturnType<typeof commandLayout>, "bindHost"> & { bindHost?: string };

function layoutVariables(index: number | undefined, env: DesktopEnvironment) {
  if (index !== undefined) return [];
  return [
    'desktop_index="$1"',
    `case "$desktop_index" in ''|*[!0-9]*) exit 75 ;; esac`,
    `[[ "$desktop_index" =~ ^(0|[1-9][0-9]{0,4})$ ]] || exit 75`,
    `desktop_display=$((desktop_index + ${env.displayStart}))`,
    `[ "$desktop_display" -le ${MAX_DESKTOP_DISPLAY} ] || exit 75`,
    "desktop_debug=$((9221 + desktop_display))",
  ];
}

// Expand only generated layout variables and the validated view token.
function quoteLayout(value: string) {
  return value
    .split(/(\$\{desktop_[a-z_]+\})/)
    .map((part) => (/^\$\{desktop_[a-z_]+\}$/.test(part) ? `"${part}"` : shellQuote(part)))
    .join("");
}
export function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function browserKeyForScreen(screenId: string) {
  return createHash("sha256").update(screenId).digest("hex").slice(0, 32);
}

export function browserProfilePathForScreen(screenId: string, env = DEFAULT_DESKTOP_ENV) {
  return `${env.browserProfilesDir}/chromium-bot-${browserKeyForScreen(screenId)}`;
}

function browserPidPathForScreen(screenId: string) {
  return `/tmp/rakazo/browser-pid-${browserKeyForScreen(screenId)}`;
}

function browserRunningFunction(profile: string, pidFile: string) {
  const flag = shellQuote(`--user-data-dir=${profile}`);
  const profileQuoted = shellQuote(profile);
  return [
    // Match the configured flag in either NUL-separated argv or Chromium's one-line
    // setproctitle. Searching for the whole flag keeps spaces and " --" inside the path.
    "  cmdline_text() {",
    "    tr '\\0' '\\n' <\"/proc/$1/cmdline\" 2>/dev/null || true",
    "  }",
    "  has_arg() {",
    '    text=$(cmdline_text "$1")',
    '    if printf \'%s\\n\' "$text" | grep -Fx -- "$2" >/dev/null; then return 0; fi',
    '    if printf \' %s \' "$text" | grep -F -- " $2 " >/dev/null; then return 0; fi',
    "    return 1",
    "  }",
    "  has_prefix() {",
    '    text=$(cmdline_text "$1")',
    "    if [ $# -ge 3 ]; then",
    '      case "$text" in',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    '        *"$3"*) text="${text%%"$3"*}${text#*"$3"}" ;;',
    "      esac",
    "    fi",
    '    if printf \'%s\\n\' "$text" | grep -e "^$2" >/dev/null; then return 0; fi',
    '    if printf \' %s \' "$text" | grep -F -- " $2" >/dev/null; then return 0; fi',
    "    return 1",
    "  }",
    "  browser_matches() {",
    "    case \"$1\" in ''|0|*[!0-9]*) return 1 ;; esac",
    '    kill -0 "$1" 2>/dev/null || return 1',
    '    case "$(readlink "/proc/$1/exe" 2>/dev/null)" in */bash|*/dash|*/sh|*/timeout) return 1 ;; esac',
    `    if ! has_arg "$1" ${flag}; then return 1; fi`,
    // Browser.close reads --remote-debugging-port from this PID. Renderers inherit
    // --user-data-dir (and sometimes the port) but always carry --type=.
    // Drop the profile flag first so "--type=" or a port inside that path is not a flag.
    `    if ! has_prefix "$1" '--remote-debugging-port=' ${flag}; then return 1; fi`,
    `    if has_prefix "$1" '--type=' ${flag}; then return 1; fi`,
    `    mkdir -p "$(dirname ${pidFile})" 2>/dev/null || true`,
    `    printf %s "$1" >${pidFile} 2>/dev/null || true`,
    "    return 0",
    "  }",
    "browser_running() {",
    `  tracked=$(cat ${pidFile} 2>/dev/null || true)`,
    `  lock=$(readlink ${profileQuoted}/SingletonLock 2>/dev/null || true)`,
    // Pid files and SingletonLock miss the browser after a supervisor restart or a wrapper
    // whose lock does not point at the process that still has --user-data-dir.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    '  for pid in "$tracked" "${lock##*-}"; do',
    '    if browser_matches "$pid"; then return 0; fi',
    "  done",
    "  if [ -d /proc ]; then",
    "    for proc_dir in /proc/[0-9]*; do",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    '      pid="${proc_dir#/proc/}"',
    '      if browser_matches "$pid"; then return 0; fi',
    "    done",
    "  fi",
    "  return 1",
    "}",
  ];
}

export function browserLauncherPath(displayNumber: number | string) {
  return `/tmp/rakazo/browser-launch-${displayNumber}`;
}

// Bookworm installs the portal backends as flat files. Same paths as the boot script.
const DESKTOP_PORTAL = "/usr/libexec/xdg-desktop-portal";
const DESKTOP_PORTAL_GTK = "/usr/libexec/xdg-desktop-portal-gtk";

function screenSessionPaths(displayNumber: string) {
  return {
    bus: `/tmp/rakazo/dbus-session-${displayNumber}`,
    dbusPid: `/tmp/rakazo/dbus-pid-${displayNumber}`,
    portalPid: `/tmp/rakazo/portal-pid-${displayNumber}`,
    gtkPid: `/tmp/rakazo/portal-gtk-pid-${displayNumber}`,
    portalLog: `/tmp/rakazo/portal-${displayNumber}.log`,
    gtkLog: `/tmp/rakazo/portal-gtk-${displayNumber}.log`,
  };
}

function portalStartLine(binary: string, display: string, log: string) {
  return `DISPLAY=${display} DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" nohup ${binary} 8>&- 9>&- </dev/null >${log} 2>&1 &`;
}

// dbus-daemon copies its own environment into the activation environment.
// Publish the screen display before any backend starts, or an activated GTK
// portal inherits the image display and the explicitly started one exits.
function screenActivationLine(display: string) {
  return `if command -v dbus-update-activation-environment >/dev/null 2>&1; then dbus-update-activation-environment DISPLAY=${display} || exit 1; fi`;
}

function screenClaimGtkLines(display: string, log: string) {
  return [
    "screen_claim_gtk() {",
    `  ${portalStartLine(DESKTOP_PORTAL_GTK, display, log)}`,
    "  screen_gtk_pid=$!",
    "  screen_gtk_ready=0",
    "  for i in $(seq 1 50); do",
    // Right after the fork the pid still runs the shell or nohup until it execs the portal.
    '    screen_starting "$screen_gtk_pid" xdg-desktop-portal-gtk || break',
    "    if dbus-send --session --print-reply --dest=org.freedesktop.DBus \\",
    "        /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner \\",
    "        string:org.freedesktop.impl.portal.desktop.gtk 2>/dev/null | grep -q 'boolean true'; then",
    "      screen_gtk_ready=1",
    "      break",
    "    fi",
    "    sleep 0.1",
    "  done",
    '  if [ "$screen_gtk_ready" -ne 1 ]; then',
    '    if screen_live "$screen_gtk_pid" xdg-desktop-portal-gtk; then',
    '      kill "$screen_gtk_pid" 2>/dev/null || true',
    '      kill -KILL "$screen_gtk_pid" 2>/dev/null || true',
    "    fi",
    "    echo 'screen file chooser did not claim the bus' >&2",
    "    exit 1",
    "  fi",
    '  screen_record "$screen_gtk_pid" "$screen_gtk_pid_file"',
    "}",
  ];
}

// Pid files outlive the container, and the kernel reuses the numbers.
// Trust a recorded pid only when its start time and executable still match.
function screenSessionMatchers() {
  return [
    "screen_starttime() {",
    '  screen_stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1',
    '  case "$screen_stat" in',
    "    *')'*) ;;",
    "    *) return 1 ;;",
    "  esac",
    // Field 22 of stat is field 20 after the last ')'. $20 is not that field.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    "  screen_rest=${screen_stat##*)}",
    "  set -f",
    "  set -- $screen_rest",
    "  set +f",
    '  [ "$#" -ge 20 ] || return 1',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    "  case \"${20}\" in ''|*[!0-9]*) return 1 ;; esac",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    "  screen_starttime_value=${20}",
    "}",
    "screen_record() {",
    '  screen_starttime "$1" || return 1',
    '  printf \'%s %s\\n\' "$1" "$screen_starttime_value" >"$2"',
    "}",
    // A pid this script just forked. Start time is recorded after the claim.
    "screen_live() {",
    "  case \"$1\" in ''|*[!0-9]*|0|1) return 1 ;; esac",
    '  kill -0 "$1" 2>/dev/null || return 1',
    '  case "$(readlink "/proc/$1/exe" 2>/dev/null || true)" in',
    '    */"$2"|"$2") return 0 ;;',
    "  esac",
    "  return 1",
    "}",
    "screen_starting() {",
    '  kill -0 "$1" 2>/dev/null || return 1',
    '  case "$(readlink "/proc/$1/exe" 2>/dev/null || true)" in',
    '    */"$2"|"$2"|*/bash|*/dash|*/sh|*/nohup) return 0 ;;',
    "  esac",
    "  return 1",
    "}",
    "screen_recorded() {",
    '  [ -r "$1" ] || return 1',
    "  screen_recorded_exe=$2",
    '  screen_line=$(cat "$1" 2>/dev/null || true)',
    '  case "$screen_line" in',
    "    *' '*) ;;",
    "    *) return 1 ;;",
    "  esac",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    "  screen_recorded_pid=${screen_line%% *}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    "  screen_recorded_start=${screen_line#* }",
    '  case "$screen_recorded_start" in',
    "    *' '*) return 1 ;;",
    "  esac",
    "  case \"$screen_recorded_pid\" in ''|*[!0-9]*|0|1) return 1 ;; esac",
    "  case \"$screen_recorded_start\" in ''|*[!0-9]*) return 1 ;; esac",
    '  kill -0 "$screen_recorded_pid" 2>/dev/null || return 1',
    '  screen_starttime "$screen_recorded_pid" || return 1',
    '  [ "$screen_starttime_value" = "$screen_recorded_start" ] || return 1',
    '  case "$(readlink "/proc/$screen_recorded_pid/exe" 2>/dev/null || true)" in',
    '    */"$screen_recorded_exe"|"$screen_recorded_exe") return 0 ;;',
    '    */"$screen_recorded_exe (deleted)"|"$screen_recorded_exe (deleted)") return 0 ;;',
    "  esac",
    "  return 1",
    "}",
    "screen_stop_recorded() {",
    '  if screen_recorded "$1" "$2"; then',
    '    kill "$screen_recorded_pid" 2>/dev/null || true',
    '    kill -KILL "$screen_recorded_pid" 2>/dev/null || true',
    "  fi",
    '  rm -f "$1"',
    "}",
  ];
}

// One GTK portal process draws on a single DISPLAY. The boot backend stays on
// displayStart; every other screen needs its own session bus and backend.
function renderStartScreenSessionCommand(index: number | undefined, env: DesktopEnvironment) {
  if (index === 0) return [];
  const layout = commandLayout(index, env);
  const paths = screenSessionPaths(String(layout.displayNumber));
  const lines = [
    `screen_bus_file=${paths.bus}`,
    `screen_dbus_pid_file=${paths.dbusPid}`,
    `screen_portal_pid_file=${paths.portalPid}`,
    `screen_gtk_pid_file=${paths.gtkPid}`,
    ...screenSessionMatchers(),
    ...screenClaimGtkLines(layout.display, paths.gtkLog),
    "screen_portals=0",
    `if [ -x ${DESKTOP_PORTAL} ] && [ -x ${DESKTOP_PORTAL_GTK} ]; then screen_portals=1; fi`,
    "screen_bus_alive=0",
    'if [ -r "$screen_bus_file" ] && screen_recorded "$screen_dbus_pid_file" dbus-daemon; then screen_bus_alive=1; fi',
    'if [ "$screen_bus_alive" -eq 0 ]; then',
    '  screen_stop_recorded "$screen_portal_pid_file" xdg-desktop-portal',
    '  screen_stop_recorded "$screen_gtk_pid_file" xdg-desktop-portal-gtk',
    '  screen_stop_recorded "$screen_dbus_pid_file" dbus-daemon',
    '  rm -f "$screen_bus_file"',
    "    if command -v dbus-launch >/dev/null 2>&1; then",
    `      eval "$(DISPLAY=${layout.display} dbus-launch --sh-syntax)"`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    '      if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] || [ -z "${DBUS_SESSION_BUS_PID:-}" ]; then echo \'screen session bus did not start\' >&2; exit 1; fi',
    '      printf \'export DBUS_SESSION_BUS_ADDRESS=%q\\nexport DBUS_SESSION_BUS_PID=%q\\n\' "$DBUS_SESSION_BUS_ADDRESS" "$DBUS_SESSION_BUS_PID" >"$screen_bus_file"',
    '      screen_record "$DBUS_SESSION_BUS_PID" "$screen_dbus_pid_file"',
    `      ${screenActivationLine(layout.display)}`,
    '      if [ "$screen_portals" -eq 1 ]; then',
    "        screen_claim_gtk",
    `        ${portalStartLine(DESKTOP_PORTAL, layout.display, paths.portalLog)}`,
    '        screen_record "$!" "$screen_portal_pid_file"',
    "      fi",
    "      unset DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID",
    "    fi",
    "  else",
    '    . "$screen_bus_file"',
    `    ${screenActivationLine(layout.display)}`,
    '    if [ "$screen_portals" -eq 1 ]; then',
    '      if ! screen_recorded "$screen_gtk_pid_file" xdg-desktop-portal-gtk; then',
    "        screen_claim_gtk",
    "      fi",
    '      if ! screen_recorded "$screen_portal_pid_file" xdg-desktop-portal; then',
    `        ${portalStartLine(DESKTOP_PORTAL, layout.display, paths.portalLog)}`,
    '        screen_record "$!" "$screen_portal_pid_file"',
    "      fi",
    "    fi",
    "    unset DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID",
    "  fi",
  ];
  if (index !== undefined) return lines;
  return [`if [ "$desktop_display" != "${env.displayStart}" ]; then`, ...lines, "fi"];
}

function renderStopScreenSessionCommand(index: number | undefined, env: DesktopEnvironment) {
  if (index === 0) return [];
  const layout = commandLayout(index, env);
  const paths = screenSessionPaths(String(layout.displayNumber));
  const lines = [
    ...screenSessionMatchers(),
    `screen_stop_recorded ${paths.portalPid} xdg-desktop-portal`,
    `screen_stop_recorded ${paths.gtkPid} xdg-desktop-portal-gtk`,
    `screen_stop_recorded ${paths.dbusPid} dbus-daemon`,
    `rm -f ${paths.bus}`,
  ];
  if (index !== undefined) return lines;
  return [`if [ "$desktop_display" != "${env.displayStart}" ]; then`, ...lines, "fi"];
}

function browserSessionBusLines(index: number | undefined, env: DesktopEnvironment) {
  if (index === 0) {
    return [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
      'if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -r /tmp/rakazo/dbus-session ]; then . /tmp/rakazo/dbus-session; fi',
    ];
  }
  if (index === undefined) {
    return [
      `if [ "$desktop_display" = "${env.displayStart}" ]; then`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
      '  if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -r /tmp/rakazo/dbus-session ]; then . /tmp/rakazo/dbus-session; fi',
      "else",
      "  screen_bus=/tmp/rakazo/dbus-session-$desktop_display",
      '  if [ -r "$screen_bus" ]; then . "$screen_bus"; else unset DBUS_SESSION_BUS_ADDRESS; fi',
      "  unset screen_bus",
      "fi",
    ];
  }
  const bus = `/tmp/rakazo/dbus-session-${env.displayStart + index}`;
  return [`if [ -r ${bus} ]; then . ${bus}; else unset DBUS_SESSION_BUS_ADDRESS; fi`];
}

function browserLauncherCommand(
  index: number | undefined,
  screenId: string,
  env: DesktopEnvironment,
) {
  const layout = commandLayout(index, env);
  return [
    "#!/bin/bash",
    "set -eu",
    ...(index === undefined
      ? // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
        ['desktop_display="${0##*-}"', "desktop_debug=$((9221 + desktop_display))"]
      : []),
    "browser=$(command -v rakazo-browser || command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser)",
    `export DISPLAY=${layout.display} HOME=${shellQuote(env.homeDir)}`,
    // Docker exec does not inherit the session bus exported by container startup.
    // The boot portal draws on displayStart; other screens must source their own bus.
    ...browserSessionBusLines(index, env),
    // The image preloads libnss_wrapper so arbitrary UIDs resolve. Chromium's
    // process stays up with these flags while that library is loaded, and the
    // debugging port never opens. Drop only that entry for this exec.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    'if [ -n "${LD_PRELOAD:-}" ]; then',
    '  _kept=""',
    '  _rest="$LD_PRELOAD"',
    '  while [ -n "$_rest" ]; do',
    '    case "$_rest" in',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    '      *[:\\ ]*) _entry="${_rest%%[: ]*}"; _rest="${_rest#*[: ]}" ;;',
    '      *) _entry="$_rest"; _rest="" ;;',
    "    esac",
    '    case "$_entry" in',
    '      *libnss_wrapper.so|"") ;;',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    '      *) _kept="${_kept:+$_kept:}$_entry" ;;',
    "    esac",
    "  done",
    '  if [ -n "$_kept" ]; then export LD_PRELOAD="$_kept"; else unset LD_PRELOAD; fi',
    "  unset _kept _rest _entry",
    "fi",
    `exec "$browser" --test-type --no-sandbox --disable-dev-shm-usage --disable-gpu --enable-unsafe-swiftshader --no-first-run --no-default-browser-check --disable-session-crashed-bubble --hide-crash-restore-bubble --password-store=basic --restore-last-session --start-maximized --remote-debugging-address=127.0.0.1 --remote-debugging-port=${layout.debugPort} --user-data-dir=${shellQuote(browserProfilePathForScreen(screenId, env))} "$@"`,
  ].join("\n");
}

// Browser.close flushes cookies and profile databases; SIGTERM alone can discard recent cookies.
const CLOSE_BROWSER = `import base64, json, os, socket, sys, urllib.request
pid = sys.argv[1]
profile = ''
print_port = False
for arg in sys.argv[2:]:
    if arg == '--print-port':
        print_port = True
    elif not profile:
        profile = arg
data = open('/proc/' + pid + '/cmdline', 'rb').read().replace(b'\\0', b' ')
if profile:
    data = data.replace(b'--user-data-dir=' + profile.encode(), b' ', 1)
key = b'--remote-debugging-port='
start = len(data)
port = None
while True:
    start = data.rfind(key, 0, start)
    if start < 0:
        break
    if start == 0 or data[start - 1:start] == b' ':
        digits = bytearray()
        index = start + len(key)
        while index < len(data) and 48 <= data[index] <= 57:
            digits.append(data[index])
            index += 1
        if digits:
            port = int(digits)
            break
if port is None:
    raise SystemExit(1)
if print_port:
    print(port)
    raise SystemExit(0)
with urllib.request.urlopen('http://127.0.0.1:' + str(port) + '/json/version', timeout=2) as response:
    endpoint = json.load(response)['webSocketDebuggerUrl']
path = '/' + endpoint.split('/', 3)[3]
with socket.create_connection(('127.0.0.1', port), timeout=2) as connection:
    key = base64.b64encode(os.urandom(16)).decode()
    connection.sendall(('GET ' + path + ' HTTP/1.1\\r\\nHost: 127.0.0.1:' + str(port) + '\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Key: ' + key + '\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n').encode())
    response = b''
    while b'\\r\\n\\r\\n' not in response:
        chunk = connection.recv(4096)
        if not chunk: raise RuntimeError('browser debugger disconnected')
        response += chunk
    if b' 101 ' not in response.split(b'\\r\\n')[0]: raise RuntimeError('browser debugger rejected connection')
    payload = b'{"id":1,"method":"Browser.close"}'
    mask = os.urandom(4)
    connection.sendall(bytes([0x81, 0x80 | len(payload)]) + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(payload)))
    connection.recv(4096)
`;

export function browserCloseProgram() {
  return CLOSE_BROWSER;
}

/** Exit status of a browser stop that found a browser open on the profile again. */
export const BROWSER_STILL_RUNNING_EXIT = 76;

export function stopBrowserCommand(screenId: string, env = DEFAULT_DESKTOP_ENV) {
  return stopBrowserProfileCommand(
    browserProfilePathForScreen(screenId, env),
    browserPidPathForScreen(screenId),
  );
}

/** Close one Chromium profile with Browser.close, then SIGTERM, before a checkpoint copies it. */
export function stopBrowserProfileCommand(profile: string, pidFile: string) {
  return [
    ...browserRunningFunction(profile, pidFile),
    `if browser_running; then`,
    `  python3 -c ${shellQuote(CLOSE_BROWSER)} "$pid" ${shellQuote(profile)} >/dev/null 2>&1 || true`,
    `  for i in $(seq 1 40); do browser_matches "$pid" || break; sleep 0.25; done`,
    `  if browser_matches "$pid"; then kill "$pid" 2>/dev/null || true; for i in $(seq 1 40); do browser_matches "$pid" || break; sleep 0.25; done; fi`,
    `  browser_matches "$pid" && kill -KILL "$pid" 2>/dev/null || true`,
    `fi`,
    // A supervisor may have replaced the selected PID while it was closing.
    // Rediscover once before removing lock state rather than on every close poll.
    `if browser_running; then echo 'browser still running' >&2; exit ${BROWSER_STILL_RUNNING_EXIT}; fi`,
    `rm -f ${pidFile}`,
    `rm -f ${shellQuote(profile)}/SingletonLock ${shellQuote(profile)}/SingletonCookie ${shellQuote(profile)}/SingletonSocket`,
  ].join("\n");
}

function stopProfileDirectoriesCommand(profileList: string) {
  const placeholder = "RAKAZO_INTERNAL_PROFILE";
  const stop = stopBrowserProfileCommand(placeholder, '"$pid_file"')
    .replaceAll(shellQuote(`--user-data-dir=${placeholder}`), '"--user-data-dir=$profile"')
    .replaceAll(shellQuote(placeholder), '"$profile"');
  return [
    "set -eu",
    "failed=0",
    "running=0",
    "mkdir -p /tmp/rakazo",
    `for profile in ${profileList}; do`,
    '  [ -d "$profile" ] || continue',
    '  case "$profile" in',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    "    */chromium-bot-*) hash=${profile##*chromium-bot-} ;;",
    '    *) hash=$(basename -- "$profile") ;;',
    "  esac",
    '  pid_file="/tmp/rakazo/browser-pid-$hash"',
    `  bash -eu -c ${shellQuote(`profile=$1; pid_file=$2;\n${stop}`)} desktop "$profile" "$pid_file" || { [ "$?" -eq ${BROWSER_STILL_RUNNING_EXIT} ] && running=1 || failed=1; }`,
    "done",
    '[ "$failed" -eq 0 ] || exit 1',
    `[ "$running" -eq 0 ] || exit ${BROWSER_STILL_RUNNING_EXIT}`,
  ].join("\n");
}

/** Quiesce managed profiles before a full workspace export; orchestration excludes active peers. */
export function stopAllDesktopBrowsersCommand(env = DEFAULT_DESKTOP_ENV) {
  return stopProfileDirectoriesCommand(`${shellQuote(env.browserProfilesDir)}/chromium-bot-*`);
}

/**
 * Close every durable Chromium profile before Docker stops the container.
 * Screen assignments live only in the supervisor process, and PID 1 exits as soon as Xvfb
 * dies, so a stop that skips Browser.close SIGKILLs Chrome before cookie databases flush.
 */
export function quiesceBrowserProfilesCommand(env = DEFAULT_DESKTOP_ENV) {
  const root = shellQuote(env.browserProfilesDir);
  return stopProfileDirectoriesCommand(
    `${root}/chromium ${root}/chromium-bot-* ${root}/chromium-screen-*`,
  );
}

/** Reset discovered runtime processes after a supervisor restart; profiles remain durable. */
export function resetDesktopRuntimeCommand(env = DEFAULT_DESKTOP_ENV) {
  const port = String(env.portStart ?? 6080);
  const gatewayPattern = `^([^ ]*/)?python[0-9.]* +(-m +websockify|[^ ]*websockify[^ ]*) +.*[ :]${port}( |$)`;
  const stop = [
    ...layoutVariables(undefined, env),
    renderStopScreenTransportsCommand(undefined, env),
    ...renderStopScreenSessionCommand(undefined, env),
    ...(env.preservePrimaryDisplay
      ? [`if [ "$desktop_display" != "${env.displayStart}" ]; then`]
      : []),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    'pkill -f "[X]vfb :${desktop_display} -screen" || true',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    'pkill -f "[f]luxbox -rc /tmp/fluxbox-home-${desktop_display}/.fluxbox/init" || true',
    ...(env.preservePrimaryDisplay ? ["fi"] : []),
  ].join("\n");
  return [
    "set -eu",
    `pkill -f ${shellQuote(gatewayPattern)} || true`,
    "sleep 0.1",
    `pkill -KILL -f ${shellQuote(gatewayPattern)} || true`,
    stopAllDesktopBrowsersCommand(env),
    "for marker in /tmp/rakazo/browser-profile-*; do",
    '  [ -f "$marker" ] || continue',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    "  display=${marker##*-}",
    '  [[ "$display" =~ ^(0|[1-9][0-9]{0,4})$ ]] || continue',
    `  [ "$display" -ge ${env.displayStart} ] && [ "$display" -le ${MAX_DESKTOP_DISPLAY} ] || continue`,
    `  index=$((display - ${env.displayStart}))`,
    `  bash -eu -c ${shellQuote(stop)} desktop "$index"`,
    "done",
    // Retire the default image's legacy primary VNC process too.
    "pkill -f '^([^ ]*/)?x11vnc .* -rfbport 5900( |$)' || true",
    `rm -f ${TARGETS}/view-* ${TARGETS}/control-* /tmp/rakazo/browser-pid-* /tmp/rakazo/browser-profile-* /tmp/rakazo/browser-launch-*`,
  ].join("\n");
}

const TARGETS = "/tmp/rakazo/desktop-targets";

// Menu exec strings run through `/bin/sh -c`, where `#` starts a comment; rgb:a/b/c keeps
// hex colors intact. infra/sandboxes/computer/fluxbox.menu carries the same entry.
// selectToClipboard puts selections in CLIPBOARD, which x11vnc forwards to the host.
export const TERMINAL_MENU_COMMAND =
  "xterm -bg rgb:11/11/13 -fg rgb:e8/e8/ea -cr rgb:e8/e8/ea -title Terminal -xrm 'XTerm*selectToClipboard: true'";

// Keep fixed mapping files present: TokenFile may be reading the directory concurrently.
function revokeTargetCommand(kind: "view" | "control" | "terminal", display: number | string) {
  return `mkdir -p ${TARGETS}; : >/tmp/rakazo/${kind}-target-next-${display}; mv /tmp/rakazo/${kind}-target-next-${display} ${TARGETS}/${kind}-${display}`;
}

function stopVncCommand(kind: "view" | "control", layout: DesktopLayout) {
  const socketPrefix = `/tmp/rakazo/sockets/${kind}-${layout.displayNumber}-`;
  const pattern = quoteLayout(`^([^ ]*/)?x11vnc .* -unixsock ${socketPrefix}[^ ]+( |$)`);
  return [
    `pkill -f ${pattern} || true`,
    "sleep 0.1",
    `pkill -KILL -f ${pattern} || true`,
    `for i in $(seq 1 10); do pgrep -f ${pattern} >/dev/null || break; sleep 0.1; done`,
    `if pgrep -f ${pattern} >/dev/null; then echo 'computer screen transport failed to stop' >&2; exit 1; fi`,
    `rm -f ${socketPrefix}*`,
  ].join("\n");
}

const TERMINAL_SERVER = "/tmp/rakazo/rakazo-terminal.py";

function terminalServerPattern(socket: string) {
  return `^([^ ]*/)?python[0-9.]* ${TERMINAL_SERVER} ${socket}( |$)`;
}

function stopTerminalCommand(layout: DesktopLayout) {
  const socketPrefix = `/tmp/rakazo/sockets/terminal-${layout.displayNumber}-`;
  const pattern = quoteLayout(terminalServerPattern(`${socketPrefix}[^ ]+`));
  return [
    revokeTargetCommand("terminal", layout.displayNumber),
    // Killing the server closes every relayed connection; each shell then gets SIGHUP.
    `pkill -f ${pattern} || true`,
    `for i in $(seq 1 10); do pgrep -f ${pattern} >/dev/null || break; sleep 0.1; done`,
    `pkill -KILL -f ${pattern} || true`,
    `rm -rf ${socketPrefix}* /tmp/rakazo/terminal-state-${layout.displayNumber}`,
  ].join("\n");
}

function gatewayCommand(port: string, host = "127.0.0.1") {
  host = gatewayHost(host);
  const probeHost = gatewayProbeHost(host);
  const hostPattern = host.replaceAll(".", "[.]");
  const processPattern = `^([^ ]*/)?python[0-9.]* +(-m +websockify|[^ ]*websockify[^ ]*) +.*`;
  const portPattern = shellQuote(`${processPattern}[ :]${port}( |$)`);
  const gatewayPattern = shellQuote(
    `${processPattern}--token-source=${TARGETS} +${hostPattern}:${port}( |$)`,
  );
  return [
    proxyEnvironmentCommand(),
    `mkdir -p ${TARGETS}`,
    // This lock only covers gateway startup; desktop startup remains independent.
    `exec 10>/tmp/rakazo/gateway-${port}.lock; flock -w 120 10`,
    `if ! pgrep -f ${gatewayPattern} >/dev/null || ! (echo >/dev/tcp/${probeHost}/${port}) >/dev/null 2>&1; then`,
    // Older images boot a single-screen gateway on this port. Retire it under the startup lock.
    `  pkill -f ${portPattern} || true`,
    `  for i in $(seq 1 20); do if ! (echo >/dev/tcp/${probeHost}/${port}) >/dev/null 2>&1; then break; fi; sleep 0.1; done`,
    `  if (echo >/dev/tcp/${probeHost}/${port}) >/dev/null 2>&1; then echo 'screen gateway port is busy' >&2; exit 1; fi`,
    `  nohup "$proxy" --heartbeat=30 --web="$web" --token-plugin=TokenFile --token-source=${TARGETS} ${host}:${port} 8>&- 9>&- 10>&- </dev/null >/tmp/rakazo/gateway-${port}.log 2>&1 &`,
    "fi",
    `for i in $(seq 1 50); do (echo >/dev/tcp/${probeHost}/${port}) >/dev/null 2>&1 && break; sleep 0.1; done`,
    `flock -u 10; exec 10>&-`,
    `if ! (echo >/dev/tcp/${probeHost}/${port}) >/dev/null 2>&1; then`,
    "  echo 'screen gateway did not start' >&2",
    `  tail -c 2000 /tmp/rakazo/gateway-${port}.log >&2 || true`,
    "  exit 1",
    "fi",
  ].join("\n");
}

export function stopScreenTransportsCommand(index: number, env = DEFAULT_DESKTOP_ENV) {
  return renderStopScreenTransportsCommand(index, env);
}

export function stopExtraScreenCommand(index: number, screenId: string, env = DEFAULT_DESKTOP_ENV) {
  return renderStopExtraScreenCommand(index, screenId, env);
}

export function ensureScreenCommand(
  index: number,
  screenId: string,
  viewToken: string,
  env = DEFAULT_DESKTOP_ENV,
) {
  return renderEnsureScreenCommand(index, screenId, viewToken, env);
}

function renderStopScreenTransportsCommand(index: number | undefined, env = DEFAULT_DESKTOP_ENV) {
  const layout = commandLayout(index, env);
  return [
    ...layoutVariables(index, env),
    // Drop authorization first, then terminate VNC so already connected gateway clients disconnect.
    revokeTargetCommand("view", layout.displayNumber),
    revokeTargetCommand("control", layout.displayNumber),
    stopVncCommand("view", layout),
    stopVncCommand("control", layout),
    stopTerminalCommand(layout),
    `rm -f /tmp/rakazo/control-token-${layout.displayNumber}`,
  ].join("\n");
}

function renderStopExtraScreenCommand(
  index: number | undefined,
  screenId: string,
  env = DEFAULT_DESKTOP_ENV,
) {
  const layout = commandLayout(index, env);
  const fluxHome = `/tmp/fluxbox-home-${layout.displayNumber}`;
  return [
    "set -eu",
    // Stop every client before touching browser state or recycling the display.
    renderStopScreenTransportsCommand(index, env),
    stopBrowserCommand(screenId, env),
    `rm -f /tmp/rakazo/browser-profile-${layout.displayNumber} ${browserLauncherPath(layout.displayNumber)}`,
    ...renderStopScreenSessionCommand(index, env),
    ...(index === 0 && env.preservePrimaryDisplay
      ? []
      : [
          ...(env.preservePrimaryDisplay
            ? [`if [ "${layout.displayNumber}" != "${env.displayStart}" ]; then`]
            : []),
          `pkill -f ${quoteLayout(`[X]vfb ${layout.display} -screen`)} || true`,
          `pkill -f ${quoteLayout(`[f]luxbox -rc ${fluxHome}/.fluxbox/init`)} || true`,
          `for i in $(seq 1 20); do if ! xdpyinfo -display ${layout.display} >/dev/null 2>&1; then break; fi; sleep 0.1; done`,
          `if xdpyinfo -display ${layout.display} >/dev/null 2>&1; then echo 'computer screen failed to stop' >&2; exit 1; fi`,
          `rm -f /tmp/.X${layout.displayNumber}-lock /tmp/.X11-unix/X${layout.displayNumber}`,
          ...(env.preservePrimaryDisplay ? ["fi"] : []),
        ]),
  ].join("\n");
}

/** Create only this bot's profile; its contents survive every desktop release. */
export function prepareBrowserProfileCommand(screenId: string, env = DEFAULT_DESKTOP_ENV) {
  return `mkdir -p ${shellQuote(browserProfilePathForScreen(screenId, env))}`;
}

function proxyEnvironmentCommand() {
  return [
    'if command -v websockify >/dev/null 2>&1; then proxy=$(command -v websockify); elif [ -x /opt/noVNC/utils/websockify/run ]; then proxy=/opt/noVNC/utils/websockify/run; else echo "websockify is required" >&2; exit 1; fi',
    'if [ -d /usr/share/novnc ]; then web=/usr/share/novnc; elif [ -d /opt/noVNC ]; then web=/opt/noVNC; else echo "noVNC is required" >&2; exit 1; fi',
  ].join("\n");
}

function renderEnsureScreenCommand(
  index: number | undefined,
  screenId: string,
  viewToken: string,
  env = DEFAULT_DESKTOP_ENV,
) {
  const layout = commandLayout(index, env);
  const fluxHome = `/tmp/fluxbox-home-${layout.displayNumber}`;
  const log = `/tmp/rakazo/screen-${layout.displayNumber}`;
  const profile = browserProfilePathForScreen(screenId, env);
  const pidFile = browserPidPathForScreen(screenId);
  const setupDisplay =
    index === 0 && env.preservePrimaryDisplay
      ? [
          `for i in $(seq 1 100); do xdpyinfo -display ${layout.display} >/dev/null 2>&1 && break; sleep 0.1; done`,
        ]
      : [
          // A display created before the Terminal entry already answers xdpyinfo, so the
          // branch below does not run. Rewrite the menu anyway; fluxbox rereads that file,
          // so leave the display and window manager running.
          `mkdir -p ${fluxHome}/.fluxbox`,
          // Keep apps a derived image adds to its menu; its browser entries open this screen's browser.
          `{ [ -r /etc/rakazo/fluxbox/menu ] && sed "s#{rakazo-browser\\([ }]\\)#{${browserLauncherPath(layout.displayNumber)}\\1#g" /etc/rakazo/fluxbox/menu || printf '[begin] (Desktop)\\n[exec] (Browser) {%s}\\n[exec] (Terminal) {%s}\\n[end]\\n' ${browserLauncherPath(layout.displayNumber)} ${shellQuote(TERMINAL_MENU_COMMAND)}; } >${fluxHome}/.fluxbox/menu`,
          `if ! xdpyinfo -display ${layout.display} >/dev/null 2>&1; then`,
          `  mkdir -p /tmp/rakazo ${fluxHome}/.fluxbox /tmp/.X11-unix`,
          `  rm -f /tmp/.X${layout.displayNumber}-lock /tmp/.X11-unix/X${layout.displayNumber}`,
          `  nohup Xvfb ${layout.display} -screen 0 1280x800x24 -ac +extension RANDR +render -noreset -nolisten tcp 8>&- 9>&- </dev/null >${log}-xvfb.log 2>&1 &`,
          `  for i in $(seq 1 100); do xdpyinfo -display ${layout.display} >/dev/null 2>&1 && break; sleep 0.1; done`,
          `  if ! xdpyinfo -display ${layout.display} >/dev/null 2>&1; then echo 'computer display did not start' >&2; tail -c 2000 ${log}-xvfb.log >&2 || true; exit 1; fi`,
          `  if [ -f /etc/rakazo/fluxbox/init ]; then cp /etc/rakazo/fluxbox/init ${fluxHome}/.fluxbox/init; else printf "session.screen0.toolbar.visible: false\\n" >${fluxHome}/.fluxbox/init; fi`,
          `  cp /etc/rakazo/fluxbox/apps ${fluxHome}/.fluxbox/apps 2>/dev/null || true`,
          `  printf '\\nsession.menuFile: %s\\n' ${fluxHome}/.fluxbox/menu >>${fluxHome}/.fluxbox/init`,
          // A stock image's style sets its wallpaper through fbsetbg, which opens an error dialog
          // on the screen when no wallpaper tool is installed. Paint the computer image's color.
          `  mkdir -p ${fluxHome}/bin && printf '#!/bin/sh\\nexec xsetroot -solid "#111113"\\n' >${fluxHome}/bin/fbsetbg && chmod +x ${fluxHome}/bin/fbsetbg`,
          `  PATH=${fluxHome}/bin:$PATH HOME=${shellQuote(env.homeDir)} CHROME_USER_DATA_DIR=${shellQuote(profile)} BROWSER=${browserLauncherPath(layout.displayNumber)} DISPLAY=${layout.display} nohup fluxbox -rc ${fluxHome}/.fluxbox/init 8>&- 9>&- </dev/null >${log}-fluxbox.log 2>&1 &`,
          "fi",
        ];
  const targetFile = `${TARGETS}/view-${layout.displayNumber}`;
  const socket = `/tmp/rakazo/sockets/view-${layout.displayNumber}-\${desktop_view_token}`;
  const setupView = [
    `mkdir -p ${TARGETS} /tmp/rakazo/sockets`,
    `if [ ! -S ${socket} ] || ! pgrep -f ${quoteLayout(`^([^ ]*/)?x11vnc .* -unixsock ${socket}( |$)`)} >/dev/null; then`,
    stopVncCommand("view", layout),
    `  nohup x11vnc -display ${layout.display} -forever -shared -viewonly -nopw -rfbport 0 -unixsock ${socket} -xkb -ncache 0 8>&- 9>&- </dev/null >${log}-x11vnc.log 2>&1 &`,
    "fi",
    `for i in $(seq 1 50); do [ -S ${socket} ] && break; sleep 0.1; done`,
    `if [ ! -S ${socket} ]; then echo 'screen viewer did not start' >&2; tail -c 2000 ${log}-x11vnc.log >&2 || true; exit 1; fi`,
    // Leave an unchanged mapping in place. Replacing it on every ensure races
    // TokenFile, which reloads the directory on each handshake.
    `desired=$(printf '%s: unix_socket:%s\\n' "$desktop_view_token" ${socket})`,
    `if [ ! -f ${targetFile} ] || [ "$(cat ${targetFile})" != "$desired" ]; then`,
    `  printf '%s\\n' "$desired" >/tmp/rakazo/view-target-next-${layout.displayNumber}`,
    `  mv /tmp/rakazo/view-target-next-${layout.displayNumber} ${targetFile}`,
    "fi",
    gatewayCommand(layout.viewPort, layout.bindHost),
  ];
  return [
    "set -eu",
    ...layoutVariables(index, env),
    `desktop_view_token=${shellQuote(viewToken)}`,
    '[[ "$desktop_view_token" =~ ^[a-zA-Z0-9_-]{1,64}$ ]] || exit 75',
    proxyEnvironmentCommand(),
    `mkdir -p /tmp/rakazo`,
    `printf %s ${shellQuote(browserLauncherCommand(index, screenId, env))} >${browserLauncherPath(layout.displayNumber)}`,
    `chmod 700 ${browserLauncherPath(layout.displayNumber)}`,
    ...setupDisplay,
    `xdpyinfo -display ${layout.display} >/dev/null 2>&1 || { echo 'computer display is not running' >&2; exit 1; }`,
    `mkdir -p /tmp/rakazo ${shellQuote(path.posix.dirname(profile))}`,
    ...browserRunningFunction(profile, pidFile),
    `printf %s ${shellQuote(profile)} >/tmp/rakazo/browser-profile-${layout.displayNumber}`,
    ...renderStartScreenSessionCommand(index, env),
    "launch_browser() {",
    `  ${prepareBrowserProfileCommand(screenId, env)}`,
    `  rm -f ${shellQuote(profile)}/SingletonLock ${shellQuote(profile)}/SingletonCookie ${shellQuote(profile)}/SingletonSocket`,
    `  nohup ${browserLauncherPath(layout.displayNumber)} 8>&- 9>&- </dev/null >${log}-browser.log 2>&1 & launched=$!`,
    `  printf %s "$launched" >${pidFile}`,
    "}",
    "launched=",
    "relaunched=0",
    "browser_running || launch_browser",
    "waited=0",
    'while [ "$waited" -lt 80 ]; do',
    "  if browser_running; then",
    `    (echo >/dev/tcp/127.0.0.1/${layout.debugPort}) >/dev/null 2>&1 && break`,
    // The browser found running can be closed, by its window or a home save, before its port
    // answers. Start it again once rather than wait out a browser that is gone.
    '  elif [ "$relaunched" -eq 0 ] && ! { [ -n "$launched" ] && kill -0 "$launched" 2>/dev/null; }; then',
    "    relaunched=1",
    "    waited=0",
    "    launch_browser",
    "  fi",
    "  sleep 0.25",
    "  waited=$((waited + 1))",
    "done",
    `if ! browser_running || ! (echo >/dev/tcp/127.0.0.1/${layout.debugPort}) >/dev/null 2>&1; then`,
    `  echo "computer browser CDP not ready on ${layout.debugPort} (running=$(browser_running && echo yes || echo no))" >&2`,
    `  tail -c 4000 ${log}-browser.log >&2 || true`,
    "  exit 1",
    "fi",
    ...setupView,
    `for i in $(seq 1 50); do (echo >/dev/tcp/${gatewayProbeHost(layout.bindHost)}/${layout.viewPort}) >/dev/null 2>&1 && exit 0; sleep 0.1; done`,
    "echo 'screen view port did not open' >&2",
    "exit 1",
  ].join("\n");
}

export function interactiveScreenCommand(
  interactive: boolean,
  controlToken?: string,
  layout: DesktopLayout = screenPorts(0),
) {
  const tokenFile = `/tmp/rakazo/control-token-${layout.displayNumber}`;
  const targetFile = `${TARGETS}/control-${layout.displayNumber}`;
  const stopProcesses = [
    "set -eu",
    revokeTargetCommand("control", layout.displayNumber),
    stopVncCommand("control", layout),
    // The terminal belongs to the control lease and ends with it.
    stopTerminalCommand(layout),
    `rm -f ${tokenFile}`,
  ].join("\n");
  if (!interactive) {
    if (!controlToken) return stopProcesses;
    return [
      `if [ -f ${tokenFile} ] && [ "$(cat ${tokenFile})" = ${shellQuote(controlToken)} ]; then`,
      stopProcesses,
      "printf 'RAKAZO_CONTROL_RELEASED\\n'",
      "fi",
    ].join("\n");
  }
  if (!controlToken) throw new Error("interactive screen requires a control token");
  const socket = `/tmp/rakazo/sockets/control-${layout.displayNumber}-${browserKeyForScreen(controlToken)}`;
  const process = quoteLayout(`^([^ ]*/)?x11vnc .* -unixsock ${socket}( |$)`);
  return [
    "set -eu",
    `if ! { [ -f ${tokenFile} ] && [ "$(cat ${tokenFile})" = ${shellQuote(controlToken)} ] && [ -S ${socket} ] && pgrep -f ${process} >/dev/null; }; then`,
    stopProcesses,
    `mkdir -p ${TARGETS} /tmp/rakazo/sockets`,
    // A person is typing here: shorter polling and batching show input sooner.
    `nohup x11vnc -display ${layout.display} -forever -shared -nopw -rfbport 0 -unixsock ${socket} -xkb -ncache 0 -wait 5 -defer 5 8>&- 9>&- </dev/null >/tmp/rakazo/x11vnc-control-${layout.displayNumber}.log 2>&1 &`,
    `for i in $(seq 1 50); do [ -S ${socket} ] && pgrep -f ${process} >/dev/null && break; sleep 0.1; done`,
    `[ -S ${socket} ] && pgrep -f ${process} >/dev/null || exit 1`,
    `printf %s ${shellQuote(controlToken)} >${tokenFile}`,
    "fi",
    // Repair missing/empty routes even when the input-capable process is already alive.
    `desired=$(printf '%s: unix_socket:%s\\n' ${shellQuote(controlToken)} ${socket})`,
    `if [ ! -f ${targetFile} ] || [ "$(cat ${targetFile})" != "$desired" ]; then`,
    `  printf '%s\\n' "$desired" >/tmp/rakazo/control-target-next-${layout.displayNumber}`,
    `  mv /tmp/rakazo/control-target-next-${layout.displayNumber} ${targetFile}`,
    "fi",
    gatewayCommand(layout.controlPort, layout.bindHost),
  ].join("\n");
}

/**
 * Open a terminal session for the current control lease. The lease's PTY server is reused, so
 * a second browser tab gets its own shell without ending the first; a server left from an
 * earlier lease is replaced.
 */
export function terminalCommand(
  controlToken: string,
  terminalToken: string,
  cwd: string,
  env = DEFAULT_DESKTOP_ENV,
  layout: DesktopLayout = screenPorts(0, env),
) {
  return [
    startTerminalCommand(controlToken, terminalToken, cwd, env, layout),
    proxyEnvironmentCommand(),
    gatewayCommand(layout.controlPort, layout.bindHost),
  ].join("\n");
}

/** Everything in `terminalCommand` except the shared screen gateway. */
export function startTerminalCommand(
  controlToken: string,
  terminalToken: string,
  cwd: string,
  env = DEFAULT_DESKTOP_ENV,
  layout: DesktopLayout = screenPorts(0, env),
) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(terminalToken)) throw new Error("invalid terminal token");
  const display = layout.displayNumber;
  const tokenFile = `/tmp/rakazo/control-token-${display}`;
  const socket = `/tmp/rakazo/sockets/terminal-${display}-${browserKeyForScreen(controlToken)}`;
  const target = `${TARGETS}/terminal-${display}`;
  const next = `/tmp/rakazo/terminal-target-next-${display}`;
  const entry = `printf '%s: unix_socket:%s\\n' ${shellQuote(terminalToken)} ${socket}`;
  return [
    // Callers differ (the Docker supervisor runs plain `bash -c`); an unpublished token must
    // fail here, not hand out a URL the gateway refuses.
    "set -e",
    `[ -f ${tokenFile} ] && [ "$(cat ${tokenFile})" = ${shellQuote(controlToken)} ] || exit 75`,
    `if [ -S ${socket} ] && pgrep -f ${quoteLayout(terminalServerPattern(socket))} >/dev/null; then`,
    `  { cat ${target} 2>/dev/null || true; ${entry}; } >${next}`,
    "else",
    stopTerminalCommand(layout),
    `  mkdir -p ${TARGETS} /tmp/rakazo/sockets`,
    // Displays share the program file; replace it whole so a starting server never reads half.
    `  printf %s ${shellQuote(TERMINAL_SERVER_PROGRAM)} >${TERMINAL_SERVER}.$$`,
    `  mv ${TERMINAL_SERVER}.$$ ${TERMINAL_SERVER}`,
    `  HOME=${shellQuote(env.homeDir)} nohup python3 ${TERMINAL_SERVER} ${socket} ${shellQuote(cwd)} /tmp/rakazo/terminal-state-${display} 8>&- 9>&- </dev/null >/tmp/rakazo/terminal-${display}.log 2>&1 &`,
    `  for i in $(seq 1 50); do [ -S ${socket} ] && break; sleep 0.1; done`,
    `  [ -S ${socket} ] || exit 1`,
    `  ${entry} >${next}`,
    "fi",
    `mv ${next} ${target}`,
  ].join("\n");
}

const REGISTRY = "/tmp/rakazo/desktop-assignments";
const TOKEN_PLACEHOLDER = "RAKAZO_INTERNAL_VIEW_TOKEN";

function registryLockCommand(screenId: string) {
  return [
    "set -eu",
    `dir=${shellQuote(REGISTRY)}`,
    'mkdir -p "$dir"',
    `exec 8>"$dir/${browserKeyForScreen(screenId)}.lifecycle-lock"`,
    "flock -w 120 8",
    'exec 9>"$dir/.lock"',
    "flock -w 120 9",
    `slot="$dir/${browserKeyForScreen(screenId)}.slot"`,
  ];
}

function acceptLeaseCommand(leaseId?: string, release = false) {
  return [
    `incoming=${shellQuote(leaseId ?? "")}`,
    'current=$(sed -n "2p" "$slot" 2>/dev/null || true)',
    'if [ -n "$incoming" ] && [ -n "$current" ] && [ "$incoming" != "$current" ]; then',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    "  incoming_fence=${incoming##*:}; current_fence=${current##*:}",
    '  case "$incoming_fence:$current_fence" in *[!0-9:]*|:*|*:) exit 75 ;; esac',
    release
      ? // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
        '  [ "${incoming%:*}" = "${current%:*}" ] && [ "$incoming_fence" -ge "$current_fence" ] || exit 75'
      : '  [ "$incoming_fence" -gt "$current_fence" ] || exit 75',
    "fi",
  ];
}

export function desktopWorkCommand(
  screenId: string,
  leaseId: string | undefined,
  expectedIndex: number,
  command: string,
) {
  return [
    ...registryLockCommand(screenId),
    '[ -f "$slot" ] || exit 75',
    `[ "$(sed -n '1p' "$slot")" = ${shellQuote(String(expectedIndex))} ] || exit 75`,
    ...(leaseId === undefined
      ? []
      : [`[ "$(sed -n '2p' "$slot")" = ${shellQuote(leaseId)} ] || exit 75`]),
    "flock -u 9; exec 9>&-",
    command,
  ].join("\n");
}

/** Allocate a live slot while keeping the durable profile keyed by bot identity. */
export function managedDesktopCommand(
  screenId: string,
  leaseId: string | undefined,
  env: DesktopEnvironment,
  viewToken: string,
) {
  return [
    ...registryLockCommand(screenId),
    ...acceptLeaseCommand(leaseId),
    'index=$(sed -n "1p" "$slot" 2>/dev/null || true)',
    'view_token=$(sed -n "3p" "$slot" 2>/dev/null || true)',
    'if [ -z "$index" ]; then',
    `  index=$(python3 -c ${shellQuote(`import pathlib, sys
used = set()
for slot in pathlib.Path(sys.argv[1]).glob("*.slot"):
    try:
        with slot.open() as source: used.add(int(source.readline()))
    except ValueError: pass
# A damaged assignment must not make a live display available to another bot.
for marker in pathlib.Path("/tmp/rakazo").glob("browser-profile-*"):
    display = marker.name.rsplit("-", 1)[-1]
    if display.isascii() and display.isdigit(): used.add(int(display) - ${env.displayStart})
index = 0
while index in used: index += 1
if index > ${MAX_DESKTOP_DISPLAY - env.displayStart}: sys.exit(75)
print(index)
`)} "$dir")`,
    '  [ -n "$index" ] || exit 75',
    `  view_token=${shellQuote(viewToken)}`,
    "fi",
    "case \"$view_token\" in ''|*[!a-zA-Z0-9_-]*) exit 75 ;; esac",
    '[ -n "$incoming" ] || incoming="$current"',
    'printf "%s\\n%s\\n%s\\n" "$index" "$incoming" "$view_token" >"$slot.next"',
    'mv "$slot.next" "$slot"',
    "flock -u 9; exec 9>&-",
    `bash -eu -c ${shellQuote(renderEnsureScreenCommand(undefined, screenId, TOKEN_PLACEHOLDER, env).replace(shellQuote(TOKEN_PLACEHOLDER), '"$2"'))} desktop "$index" "$view_token"`,
    'printf "RAKAZO_DESKTOP=%s:%s\\n" "$index" "$view_token"',
  ].join("\n");
}

/**
 * Run `argv` with DISPLAY on the screen assigned to `screenId`, so screen tools in a bot's
 * shell see its own desktop. Without an assignment the inherited DISPLAY stays.
 */
export function screenDisplayArgv(argv: readonly string[], screenId: string, displayStart: number) {
  const slot = `${REGISTRY}/${browserKeyForScreen(screenId)}.slot`;
  const program = [
    `index=$(sed -n 1p ${shellQuote(slot)} 2>/dev/null)`,
    `case "$index" in ''|*[!0-9]*) ;; *) DISPLAY=:$((index + ${displayStart})); export DISPLAY ;; esac`,
    'exec "$@"',
  ].join("\n");
  return ["sh", "-c", program, "sh", ...argv];
}

/** Tear down before freeing a slot; failed teardown leaves it reserved for retry. */
export function releaseDesktopCommand(
  screenId: string,
  leaseId: string | undefined,
  env: DesktopEnvironment,
) {
  return [
    ...registryLockCommand(screenId),
    '[ -f "$slot" ] || exit 0',
    ...acceptLeaseCommand(leaseId, true),
    'index=$(sed -n "1p" "$slot")',
    "flock -u 9; exec 9>&-",
    `bash -eu -c ${shellQuote(renderStopExtraScreenCommand(undefined, screenId, env))} desktop "$index"`,
    // Chromium has stopped. Publish that before clearing the slot so a later
    // lock or removal failure is not read as a browser that is still running.
    // set -e leaves that failure non-zero, and the slot is removed only while
    // the shared registry lock is held.
    'printf "RAKAZO_DESKTOP_RELEASED=%s\\n" "$index"',
    'exec 9>"$dir/.lock"',
    "flock -w 120 9",
    'rm -f -- "$slot"',
  ].join("\n");
}

/**
 * Guard a control transition with the persisted allocation and execution fence.
 * Revoking without a token ends any control on the display but keeps its slot, fence,
 * view, and browser for the bot's next run.
 */
export function desktopControlCommand(
  screenId: string,
  leaseId: string | undefined,
  env: DesktopEnvironment,
  interactive: boolean,
  token?: string,
) {
  return [
    ...registryLockCommand(screenId),
    `[ -f "$slot" ] || exit ${interactive ? 75 : 0}`,
    ...acceptLeaseCommand(leaseId, !interactive),
    'index=$(sed -n "1p" "$slot")',
    "flock -u 9; exec 9>&-",
    `bash -eu -c ${shellQuote([...layoutVariables(undefined, env), interactiveScreenCommand(interactive, token, commandLayout(undefined, env))].join("\n"))} desktop "$index"`,
  ].join("\n");
}

/** Open a terminal on this bot's assigned display; it requires the display's current control token. */
export function desktopTerminalCommand(
  screenId: string,
  leaseId: string | undefined,
  env: DesktopEnvironment,
  controlToken: string,
  terminalToken: string,
  cwd: string,
) {
  return [
    ...registryLockCommand(screenId),
    '[ -f "$slot" ] || exit 75',
    ...acceptLeaseCommand(leaseId),
    'index=$(sed -n "1p" "$slot")',
    "flock -u 9; exec 9>&-",
    `bash -eu -c ${shellQuote([...layoutVariables(undefined, env), terminalCommand(controlToken, terminalToken, cwd, env, commandLayout(undefined, env))].join("\n"))} desktop "$index"`,
  ].join("\n");
}

export function desktopUrl(screenUrl: string, token: string) {
  const url = new URL(screenUrl);
  url.searchParams.set("autoconnect", "true");
  url.searchParams.set("resize", "scale");
  const socketQuery = new URLSearchParams(new URL(screenUrl).search);
  socketQuery.set("token", token);
  url.searchParams.set("path", `websockify?${socketQuery}`);
  return url.toString();
}
