import { describe, expect, it } from 'vitest';
import { classifyHappyProcess } from './doctor';

describe('classifyHappyProcess', () => {
  it('should ignore unrelated processes with "happy" in the name', () => {
    const res = classifyHappyProcess({ pid: 123, name: 'happy-hour', cmd: 'happy-hour --serve' });
    expect(res).toBeNull();
  });

  it('should detect a daemon process started from dist', () => {
    const res = classifyHappyProcess({
      pid: 123,
      name: 'node',
      cmd: '/usr/bin/node /repo/dist/index.mjs daemon start-sync',
    });
    expect(res).not.toBeNull();
    expect(res!.type).toBe('daemon');
  });

  it('should detect a daemon-spawned session process', () => {
    const res = classifyHappyProcess({
      pid: 123,
      name: 'node',
      cmd: '/usr/bin/node /repo/dist/index.mjs --started-by daemon',
    });
    expect(res).not.toBeNull();
    expect(res!.type).toBe('daemon-spawned-session');
  });

  it('should detect a dev daemon started from tsx', () => {
    const res = classifyHappyProcess({
      pid: 123,
      name: 'node',
      cmd: '/usr/bin/node /repo/node_modules/.bin/tsx src/index.ts daemon start-sync --happy-cli',
    });
    expect(res).not.toBeNull();
    expect(res!.type).toBe('dev-daemon');
  });
});

