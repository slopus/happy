import { describe, expect, it } from 'vitest';
import { createAgyBackend, shouldUseSdkEngine } from './createAgyBackend';
import { AgyBackend } from './AgyBackend';
import { AgySdkBackend } from './AgySdkBackend';

describe('createAgyBackend factory', () => {
  it('detects SDK engine when forceEngine=sdk or apiKey is provided', () => {
    expect(shouldUseSdkEngine({ cwd: '/work', permissionMode: 'default', forceEngine: 'sdk' })).toBe(true);
    expect(shouldUseSdkEngine({ cwd: '/work', permissionMode: 'default', apiKey: 'test-key' })).toBe(true);
  });

  it('detects CLI engine when no apiKey and forceEngine=cli or default without apiKey', () => {
    expect(shouldUseSdkEngine({ cwd: '/work', permissionMode: 'default', forceEngine: 'cli' })).toBe(false);
    expect(shouldUseSdkEngine({ cwd: '/work', permissionMode: 'default' })).toBe(false);
  });

  it('instantiates AgyBackend when CLI engine is chosen', () => {
    const backend = createAgyBackend({ cwd: '/work', permissionMode: 'default', forceEngine: 'cli' });
    expect(backend).toBeInstanceOf(AgyBackend);
  });

  it('instantiates AgySdkBackend when SDK engine is chosen', () => {
    const backend = createAgyBackend({ cwd: '/work', permissionMode: 'default', forceEngine: 'sdk' });
    expect(backend).toBeInstanceOf(AgySdkBackend);
  });
});
