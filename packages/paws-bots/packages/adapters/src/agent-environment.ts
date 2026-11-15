import { redactSecrets } from "@rakazo/core";

export function formatAgentEnvironmentInstruction(
  environment: Record<string, string>,
): string | undefined {
  const names = Object.keys(environment).sort();
  if (names.length === 0) return undefined;
  return `Managed credentials are available to shell commands as these environment variables: ${names.join(", ")}. Use them without printing, logging, or embedding their values in files or messages.`;
}

export function redactShellStreams(
  snapshot: { stdout: string; stderr: string },
  secrets: string[],
  options?: { withholdPartial?: boolean },
): { stdout: string; stderr: string } {
  const values = secrets.filter((secret) => secret.length > 0);
  let stdout = redactSecrets(snapshot.stdout, values);
  let stderr = redactSecrets(snapshot.stderr, values);
  for (let pass = 0; pass < values.length; pass++) {
    let changed = false;
    for (const secret of values) {
      const next = redactSpanningSecret(stdout, stderr, secret);
      if (next.stdout !== stdout || next.stderr !== stderr) {
        stdout = next.stdout;
        stderr = next.stderr;
        changed = true;
      }
    }
    if (!changed) break;
  }
  if (!options?.withholdPartial) return { stdout, stderr };
  return withholdSecretPrefix(stdout, stderr, values);
}

export function redactAgentCommandResult(
  result: { stdout: string; stderr: string; code: number },
  secrets: string[],
) {
  return { ...result, ...redactShellStreams(result, secrets) };
}

function redactSpanningSecret(
  stdout: string,
  stderr: string,
  secret: string,
): { stdout: string; stderr: string } {
  if (secret.length < 2 || stdout.length === 0 || stderr.length === 0) return { stdout, stderr };
  const headLen = Math.min(secret.length - 1, stdout.length);
  const tailLen = Math.min(secret.length - 1, stderr.length);
  const head = stdout.slice(stdout.length - headLen);
  const boundary = head + stderr.slice(0, tailLen);
  const index = boundary.indexOf(secret);
  if (index < 0) return { stdout, stderr };
  const start = stdout.length - headLen + index;
  const end = start + secret.length;
  if (start >= stdout.length || end <= stdout.length) return { stdout, stderr };
  return {
    stdout: `${stdout.slice(0, start)}[redacted]`,
    stderr: stderr.slice(end - stdout.length),
  };
}

/** Longest suffix of `text` that is a proper prefix of `secret`. */
function secretPrefixSuffixLength(text: string, secret: string): number {
  const max = Math.min(secret.length - 1, text.length);
  const regionStart = text.length - max;
  for (let index = regionStart; index < text.length; index++) {
    if (text.charCodeAt(index) !== secret.charCodeAt(0)) continue;
    const size = text.length - index;
    let matches = true;
    for (let offset = 1; offset < size; offset++) {
      if (text.charCodeAt(index + offset) !== secret.charCodeAt(offset)) {
        matches = false;
        break;
      }
    }
    if (matches) return size;
  }
  return 0;
}

/** How far `text` continues `secret` from `offset`, in UTF-16 code units. */
function secretContinuationLength(text: string, secret: string, offset: number): number {
  const limit = Math.min(text.length, secret.length - offset);
  let size = 0;
  while (size < limit && text.charCodeAt(size) === secret.charCodeAt(offset + size)) size += 1;
  return size;
}

function splitsSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function publishWithheld(text: string, holdStart: number, holdEnd: number): string {
  if (holdStart <= 0 && holdEnd <= 0) return text;
  let start = Math.max(holdStart, 0);
  let end = holdEnd > 0 ? text.length - holdEnd : text.length;
  // Keep a surrogate pair out of the published view rather than splitting it.
  if (splitsSurrogatePair(text, start)) start += 1;
  if (splitsSurrogatePair(text, end)) end -= 1;
  if (end <= start) return "";
  return text.slice(start, end);
}

function withholdSecretPrefix(
  stdout: string,
  stderr: string,
  secrets: string[],
): { stdout: string; stderr: string } {
  let stdoutHold = 0;
  let stderrHoldEnd = 0;
  let stderrHoldStart = 0;
  for (const secret of secrets) {
    if (secret.length < 2) continue;
    const stdoutPrefix = secretPrefixSuffixLength(stdout, secret);
    stdoutHold = Math.max(stdoutHold, stdoutPrefix);
    stderrHoldEnd = Math.max(stderrHoldEnd, secretPrefixSuffixLength(stderr, secret));
    // The live view joins the streams. A prefix that ends stdout and continues into
    // stderr is one secret fragment: holding only the stdout piece would publish the rest.
    if (stdoutPrefix > 0) {
      stderrHoldStart = Math.max(
        stderrHoldStart,
        secretContinuationLength(stderr, secret, stdoutPrefix),
      );
    }
  }
  return {
    stdout: publishWithheld(stdout, 0, stdoutHold),
    stderr: publishWithheld(stderr, stderrHoldStart, stderrHoldEnd),
  };
}
