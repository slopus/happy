import { describe, expect, it, vi } from 'vitest';

import { createAgyQuotaClient, type AgyQuotaClientDeps } from './agyQuotaClient';

const TOKEN_FILE = /antigravity-oauth-token$/;
const CREDS_CACHE = /\.happy-usage-creds\.json$/;

/** A binary dump with one valid client id + secret (a 35-char GOCSPX pair). */
const GOOD_DUMP =
  'noise 123456789-abcdefghijklmno.apps.googleusercontent.com noise ' +
  'GOCSPX-abcdefghijklmnopqrstuvwxyz0123456789 more';

type Res = { ok: boolean; status: number; json: () => Promise<unknown> };
const ok = (data: unknown): Res => ({ ok: true, status: 200, json: async () => data });
const err = (status: number): Res => ({ ok: false, status, json: async () => ({}) });

/** Route fetch by url substring; each route is a queue drained per call (last repeats). */
function makeFetch(routes: Record<string, Res[]>) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    for (const [needle, queue] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return (queue.length > 1 ? queue.shift()! : queue[0]) as unknown as Response;
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function makeDeps(over: Partial<AgyQuotaClientDeps> = {}): AgyQuotaClientDeps {
  return {
    readTextFile: async (p) => {
      if (TOKEN_FILE.test(p)) return JSON.stringify({ token: { refresh_token: 'RT' } });
      throw new Error('ENOENT'); // no creds cache by default
    },
    writeTextFile: vi.fn(async () => {}),
    dumpBinaryStrings: async () => GOOD_DUMP,
    resolveBin: () => '/fake/agy',
    now: () => 1_000_000,
    ...over,
  };
}

describe('createAgyQuotaClient', () => {
  it('mints a token by scanning the binary, then fetches quota', async () => {
    const { fn, calls } = makeFetch({
      'oauth2.googleapis.com': [ok({ access_token: 'AT', expires_in: 3600 })],
      retrieveUserQuota: [ok({ buckets: [{ modelId: 'x', remainingFraction: 0.5, resetTime: 't' }] })],
    });
    const writeTextFile = vi.fn(async () => {});
    const client = createAgyQuotaClient(makeDeps({ fetch: fn, writeTextFile }));

    const quota = await client.fetchQuota();

    expect(quota).toEqual({ buckets: [{ modelId: 'x', remainingFraction: 0.5, resetTime: 't' }] });
    // The working (clientId, secret) pair is cached for next time.
    expect(writeTextFile).toHaveBeenCalledOnce();
    const cached = JSON.parse((writeTextFile.mock.calls[0] as unknown[])[1] as string);
    expect(cached.clientId).toBe('123456789-abcdefghijklmno.apps.googleusercontent.com');
    expect(cached.clientSecret).toMatch(/^GOCSPX-/);
    expect(cached.clientSecret).toHaveLength(35);
    expect(calls.filter((u) => u.includes('oauth2'))).toHaveLength(1);
  });

  it('uses a cached OAuth client without scanning the binary', async () => {
    const dumpBinaryStrings = vi.fn(async () => GOOD_DUMP);
    const { fn } = makeFetch({
      'oauth2.googleapis.com': [ok({ access_token: 'AT', expires_in: 3600 })],
      retrieveUserQuota: [ok({ buckets: [] })],
    });
    const client = createAgyQuotaClient(
      makeDeps({
        fetch: fn,
        dumpBinaryStrings,
        readTextFile: async (p) => {
          if (TOKEN_FILE.test(p)) return JSON.stringify({ token: { refresh_token: 'RT' } });
          if (CREDS_CACHE.test(p)) return JSON.stringify({ clientId: 'cid', clientSecret: 'sec' });
          throw new Error('ENOENT');
        },
      }),
    );

    await client.fetchQuota();
    expect(dumpBinaryStrings).not.toHaveBeenCalled();
  });

  it('re-scans when the cached client no longer works (self-heal)', async () => {
    const dumpBinaryStrings = vi.fn(async () => GOOD_DUMP);
    const { fn } = makeFetch({
      // First token exchange (cached client) fails, second (scanned) succeeds.
      'oauth2.googleapis.com': [err(400), ok({ access_token: 'AT', expires_in: 3600 })],
      retrieveUserQuota: [ok({ buckets: [] })],
    });
    const writeTextFile = vi.fn(async () => {});
    const client = createAgyQuotaClient(
      makeDeps({
        fetch: fn,
        dumpBinaryStrings,
        writeTextFile,
        readTextFile: async (p) => {
          if (TOKEN_FILE.test(p)) return JSON.stringify({ token: { refresh_token: 'RT' } });
          if (CREDS_CACHE.test(p)) return JSON.stringify({ clientId: 'stale', clientSecret: 'stale' });
          throw new Error('ENOENT');
        },
      }),
    );

    await client.fetchQuota();
    expect(dumpBinaryStrings).toHaveBeenCalledOnce();
    expect(writeTextFile).toHaveBeenCalledOnce(); // freshly discovered pair re-cached
  });

  it('reuses the in-memory access token across polls', async () => {
    const { fn, calls } = makeFetch({
      'oauth2.googleapis.com': [ok({ access_token: 'AT', expires_in: 3600 })],
      retrieveUserQuota: [ok({ buckets: [] }), ok({ buckets: [] })],
    });
    const client = createAgyQuotaClient(makeDeps({ fetch: fn }));

    await client.fetchQuota();
    await client.fetchQuota();

    expect(calls.filter((u) => u.includes('oauth2'))).toHaveLength(1); // token minted once
    expect(calls.filter((u) => u.includes('retrieveUserQuota'))).toHaveLength(2);
  });

  it('refreshes the token once on a 401 and retries the quota call', async () => {
    const { fn, calls } = makeFetch({
      'oauth2.googleapis.com': [
        ok({ access_token: 'AT1', expires_in: 3600 }),
        ok({ access_token: 'AT2', expires_in: 3600 }),
      ],
      retrieveUserQuota: [err(401), ok({ buckets: [] })],
    });
    const client = createAgyQuotaClient(makeDeps({ fetch: fn }));

    await expect(client.fetchQuota()).resolves.toEqual({ buckets: [] });
    expect(calls.filter((u) => u.includes('oauth2'))).toHaveLength(2); // forced re-mint
  });

  it('throws a clear error when no refresh token is present', async () => {
    const client = createAgyQuotaClient(
      makeDeps({ readTextFile: async () => JSON.stringify({ token: {} }) }),
    );
    await expect(client.fetchQuota()).rejects.toThrow(/refresh_token not found/);
  });
});
