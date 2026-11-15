import type { CommandRequest } from "@rakazo/adapter-kit";

/** Unsets win over both inherited and explicitly supplied values. */
export function sandboxCommandEnvironment(
  request: Pick<CommandRequest, "env" | "unsetEnv">,
  inherited: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const env = { ...inherited, ...request.env };
  for (const name of request.unsetEnv ?? []) {
    delete env[name];
    // Windows environment names are case-insensitive, including inherited host names.
    if (process.platform === "win32") {
      for (const key of Object.keys(env)) {
        if (key.toUpperCase() === name.toUpperCase()) delete env[key];
      }
    }
  }
  return env;
}

/** Linux providers overlay env through their SDK; remove inherited values in the child. */
export function sandboxCommandArgv(request: CommandRequest): string[] {
  if (!request.unsetEnv?.length) return request.argv;
  return ["env", ...request.unsetEnv.flatMap((name) => ["-u", name]), "--", ...request.argv];
}

/** What a shell, tools, and app launchers need. Case-insensitive for Windows and lowercase proxies. */
const HOST_COMMAND_ENV = new Set(
  [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LANGUAGE",
    "TERM",
    "TZ",
    "TMPDIR",
    "TEMP",
    "TMP",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    // The user's SSH agent and CA bundles, so git, ssh and HTTPS tools work as in their shell.
    "SSH_AUTH_SOCK",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "GIT_SSL_CAINFO",
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "PATHEXT",
    "USERNAME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "CommonProgramW6432",
    "ALLUSERSPROFILE",
    "PUBLIC",
    "PSModulePath",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
  ].map((name) => name.toUpperCase()),
);

/** Host commands get the request env over a minimal shell env, never the backend's own variables. */
export function hostCommandEnvironment(
  request: Pick<CommandRequest, "env" | "unsetEnv">,
  inherited: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const allowed: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(inherited)) {
    const key = name.toUpperCase();
    if (HOST_COMMAND_ENV.has(key) || key.startsWith("LC_")) allowed[name] = value;
  }
  return sandboxCommandEnvironment(request, allowed);
}
