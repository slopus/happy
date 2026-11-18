import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from './logger';

const originalDebug = process.env.DEBUG;

afterEach(() => {
  if (originalDebug === undefined) delete process.env.DEBUG;
  else process.env.DEBUG = originalDebug;
  vi.restoreAllMocks();
});

describe('Logger', () => {
  it('does not inspect large JSON payloads in production', () => {
    delete process.env.DEBUG;
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const payload = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        throw new Error('payload was inspected');
      },
    });

    expect(() => logger.debugLargeJson('payload', payload)).not.toThrow();
    expect(debug).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenCalledWith('In production, skipping message inspection');
  });
});
