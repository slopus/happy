import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('writeSessionExitReport', () => {
  it('writes a JSON report to disk', async () => {
    const { writeSessionExitReport } = await import('./sessionExitReport');
    const dir = await mkdtemp(join(tmpdir(), 'happy-exit-report-'));

    const outPath = await writeSessionExitReport({
      baseDir: dir,
      sessionId: 'sess_1',
      pid: 123,
      report: {
        observedAt: 1,
        observedBy: 'daemon',
        reason: 'process-missing',
      },
    });

    const raw = await readFile(outPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({
      sessionId: 'sess_1',
      pid: 123,
      observedAt: 1,
      observedBy: 'daemon',
      reason: 'process-missing',
    });
  });

  it('writes a JSON report to disk (sync)', async () => {
    const { writeSessionExitReportSync } = await import('./sessionExitReport');
    const dir = await mkdtemp(join(tmpdir(), 'happy-exit-report-sync-'));

    const outPath = writeSessionExitReportSync({
      baseDir: dir,
      sessionId: 'sess_2',
      pid: 456,
      report: {
        observedAt: 2,
        observedBy: 'session',
        reason: 'uncaught-exception',
      },
    });

    const raw = await readFile(outPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({
      sessionId: 'sess_2',
      pid: 456,
      observedAt: 2,
      observedBy: 'session',
      reason: 'uncaught-exception',
    });
  });

  it('defaults to HAPPY_HOME_DIR/logs/session-exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-home-dir-'));
    vi.stubEnv('HAPPY_HOME_DIR', dir);

    try {
      // Ensure Configuration picks up the test HAPPY_HOME_DIR.
      vi.resetModules();
      const { writeSessionExitReportSync } = await import('./sessionExitReport');

      const outPath = writeSessionExitReportSync({
        sessionId: 'sess_3',
        pid: 789,
        report: {
          observedAt: 3,
          observedBy: 'daemon',
          reason: 'process-missing',
        },
      });

      expect(outPath.startsWith(join(dir, 'logs', 'session-exit'))).toBe(true);
      const raw = await readFile(outPath, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed).toMatchObject({
        sessionId: 'sess_3',
        pid: 789,
        observedAt: 3,
        observedBy: 'daemon',
        reason: 'process-missing',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
