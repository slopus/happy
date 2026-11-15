import { shellQuote } from "./computer-support.js";

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A shell script that exports `env`, for providers whose exec API has no env field. It travels
 * outside the command text, so values never reach the sandbox's process list or command logs.
 */
export function shellExportScript(env: Record<string, string>): string {
  const assignments = Object.entries(env).map(([name, value]) => {
    if (!SHELL_NAME.test(name)) throw new Error(`invalid environment variable name: ${name}`);
    return `${name}=${shellQuote(value)}`;
  });
  // One `export` so the script fails when any assignment does, such as a readonly name.
  return assignments.length ? `export ${assignments.join(" ")}\n` : "";
}

/**
 * Opens the env file, deletes it, then loads it from the open descriptor, so it is gone before
 * the requested env (which may change PATH) applies and before `argv` runs. Reopening
 * `/dev/fd/3` fails for a deleted file on FUSE homes, and a failed read must not run `argv`
 * without its env. No shell variables: the requested env may set any name.
 */
export function sourceEnvironmentCommand(envFile: string, argv: string): string {
  const file = shellQuote(envFile);
  return `exec 3< ${file} || exit 1; rm -f -- ${file}; eval "$(cat <&3 || echo exit 1)" || exit 1; exec 3<&-; ${argv}`;
}
