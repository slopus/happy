import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('pi-happy package manifest', () => {
  it('declares the pi package manifest, runtime dependencies, and peer dependencies', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {
      keywords?: string[];
      pi?: { extensions?: string[] };
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    expect(packageJson.keywords).toContain('pi-package');
    expect(packageJson.pi?.extensions).toEqual(['./extensions']);

    expect(packageJson.dependencies).toMatchObject({
      '@paralleldrive/cuid2': '^2.2.2',
      '@slopus/happy-wire': '^0.1.0',
      axios: '^1.13.2',
      'happy-agent': '^0.1.0',
      'socket.io-client': '^4.8.1',
      tweetnacl: '^1.0.3',
      zod: '3.25.76',
    });

    expect(packageJson.peerDependencies).toMatchObject({
      '@mariozechner/pi-coding-agent': '*',
      '@mariozechner/pi-tui': '*',
      '@sinclair/typebox': '*',
    });
  });
});
