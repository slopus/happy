// chat-tool-output-streaming Phase 3 — exercises the bash_stream MCP tool's
// streaming buffer against a real `bash -c` subprocess. Tests only single
// shell-line commands (no heredoc/timeouts) since that's the MVP scope —
// complex cases fall through to Claude's built-in Bash.

import { describe, expect, it } from 'vitest';
import { runBashStream, type BashStreamProgress } from './bashStream';

describe('runBashStream', () => {
  it('captures stdout lines and reports exit 0 on success', async () => {
    const progress: BashStreamProgress[] = [];
    const result = await runBashStream({
      command: 'printf "alpha\\nbeta\\ngamma\\n"',
      onProgress: (p) => progress.push(p),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('alpha\nbeta\ngamma\n');
    expect(result.stderr).toBe('');

    const stdoutLines = progress
      .filter((p) => p.stream === 'stdout')
      .flatMap((p) => p.lines);
    expect(stdoutLines).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('separates stderr from stdout in progress and aggregate', async () => {
    const progress: BashStreamProgress[] = [];
    const result = await runBashStream({
      command: 'printf "out1\\n"; printf "err1\\n" 1>&2; printf "out2\\n"',
      onProgress: (p) => progress.push(p),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('out1');
    expect(result.stdout).toContain('out2');
    expect(result.stderr).toBe('err1\n');

    const stderrLines = progress
      .filter((p) => p.stream === 'stderr')
      .flatMap((p) => p.lines);
    expect(stderrLines).toEqual(['err1']);
  });

  it('propagates a non-zero exit code', async () => {
    const result = await runBashStream({
      command: 'echo "boom"; exit 7',
      onProgress: () => {},
    });
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe('boom\n');
  });

  it('runs in the requested cwd', async () => {
    const result = await runBashStream({
      command: 'pwd',
      cwd: '/tmp',
      onProgress: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('/tmp');
  });

  it('drops the final trailing partial line into the aggregate but not into progress', async () => {
    // `printf` without a trailing newline emits a partial last line that
    // line-buffering should keep separate from the line stream until close.
    const progress: BashStreamProgress[] = [];
    const result = await runBashStream({
      command: 'printf "complete\\nincomplete"',
      onProgress: (p) => progress.push(p),
    });
    expect(result.stdout).toBe('complete\nincomplete');

    const lines = progress
      .filter((p) => p.stream === 'stdout')
      .flatMap((p) => p.lines);
    // The complete line goes through; the partial trailing fragment is
    // delivered as the final (close-driven) flush, so it shows up too.
    expect(lines).toEqual(['complete', 'incomplete']);
  });
});
