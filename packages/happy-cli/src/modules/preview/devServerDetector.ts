/**
 * Patterns that detect a port number from various dev server log formats:
 *   - localhost:3000
 *   - 127.0.0.1:5173
 *   - Vite:  "Local:   http://localhost:5173/"
 *   - Next:  "ready on http://localhost:3000"
 *   - plain: "listening on port 3000"
 */
const URL_PATTERNS: RegExp[] = [
  // http(s)://localhost:PORT  or  http(s)://127.0.0.1:PORT
  /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/gi,
  // bare  localhost:PORT  or  127.0.0.1:PORT  (no scheme)
  /(?:localhost|127\.0\.0\.1):(\d+)/gi,
  // "listening on port PORT" / "port PORT"
  /\bport\s+(\d+)/gi,
];

const FILE_MUTATING_BASH_COMMANDS = [
  "mv",
  "cp",
  "rm",
  "mkdir",
  "touch",
  "tee",
  "truncate",
  "chmod",
  "chown",
  "sed",
  "awk",
  "perl",
  "python",
  "python3",
  "node",
  "npx",
  "yarn",
  "pnpm",
  "npm",
  "patch",
  "rsync",
];

const CSS_EXTENSIONS = /\.(css|scss|sass|less)$/i;

/**
 * Extract unique port numbers from dev server output strings.
 * Handles Vite, Next.js, and other common log formats.
 */
export function extractUrlsFromOutput(output: string): number[] {
  const ports = new Set<number>();

  for (const pattern of URL_PATTERNS) {
    // Reset lastIndex since we reuse the same RegExp objects
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(output)) !== null) {
      const port = parseInt(match[1], 10);
      if (port > 0 && port <= 65535) {
        ports.add(port);
      }
    }
  }

  return Array.from(ports);
}

/**
 * Returns true if the given tool invocation should trigger a dev-server reload.
 * Covers:
 *   - Edit / Write tool calls (file mutations by the AI)
 *   - Bash commands that mutate files
 */
export function shouldTriggerReload(toolName: string, toolArgs?: string): boolean {
  const name = toolName.toLowerCase();

  if (name === "edit" || name === "write") {
    return true;
  }

  if (name === "bash" || name === "run_command") {
    if (!toolArgs) return false;
    const firstToken = toolArgs.trim().split(/\s+/)[0].toLowerCase();
    return FILE_MUTATING_BASH_COMMANDS.includes(firstToken);
  }

  return false;
}

/**
 * Returns true if the change only affects CSS/SCSS/SASS/LESS files,
 * which may allow a lighter-weight style injection instead of a full reload.
 */
export function detectCssOnlyChange(toolName: string, filePath?: string): boolean {
  if (!filePath) return false;

  const name = toolName.toLowerCase();
  if (name !== "edit" && name !== "write") return false;

  return CSS_EXTENSIONS.test(filePath);
}
