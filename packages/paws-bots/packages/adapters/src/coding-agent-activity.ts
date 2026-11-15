import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";

/**
 * A coding agent CLI and the session files, relative to the home folder, it writes while it
 * works. An agent waiting at its prompt writes nothing, so a recent write means it is working.
 */
export interface CodingAgent {
  name: string;
  sessionFiles: readonly string[];
}

export const CODING_AGENTS: readonly CodingAgent[] = [
  { name: "codex", sessionFiles: [".codex/sessions"] },
  { name: "claude", sessionFiles: [".claude/projects"] },
  {
    name: "opencode",
    sessionFiles: [".local/share/opencode/opencode.db", ".local/share/opencode/opencode.db-wal"],
  },
];

// Prints the first agent with a session file written in the last $1 minutes.
export const CODING_AGENT_PROBE = [
  'cd "$HOME" || exit 2',
  'minutes="$1"',
  "shift",
  'while [ "$#" -ge 2 ]; do',
  '  name="$1"',
  '  path="$2"',
  "  shift 2",
  '  [ -e "$path" ] || continue',
  '  if [ -n "$(find "$path" -type f -mmin "-$minutes" -print -quit 2>/dev/null)" ]; then',
  '    printf "%s\\n" "$name"',
  "    exit 0",
  "  fi",
  "done",
  "exit 1",
].join("\n");

/** The coding agent that wrote its session within `windowMs`, if any. Unreadable means none. */
export async function activeCodingAgent(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  windowMs: number,
): Promise<string | undefined> {
  const entries = CODING_AGENTS.flatMap((agent) =>
    agent.sessionFiles.flatMap((file) => [agent.name, file]),
  );
  let stdout = "";
  try {
    for await (const event of sandbox.execute(
      computer,
      {
        argv: [
          "bash",
          "-c",
          CODING_AGENT_PROBE,
          "rakazo-coding-agent-probe",
          String(Math.max(1, Math.ceil(windowMs / 60_000))),
          ...entries,
        ],
        timeoutMs: 10_000,
      },
      context,
    )) {
      if (event.type === "stdout") stdout += event.data;
    }
  } catch {
    return undefined;
  }
  const name = stdout.trim();
  return CODING_AGENTS.some((agent) => agent.name === name) ? name : undefined;
}
