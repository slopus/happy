/**
 * Fetches agy (Antigravity) usage quota from Google's cloudcode-pa backend.
 *
 * agy exposes no quota over its CLI stream, so this talks to the same private
 * endpoint the CLI itself uses:
 *   POST cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota
 * authenticated with a short-lived access token minted from agy's stored refresh
 * token. The OAuth client_id/secret are not published; we recover them by
 * scanning the agy binary (self-healing across agy upgrades that rotate the
 * client) and cache the working pair. Ported from the ai-usage SwiftBar plugin.
 *
 * All external effects (fs, `strings`, fetch) are injectable so the token/quota
 * logic is unit-testable without a real binary or network.
 */
import os from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { resolveAgyBin } from './constants';
import type { AgyQuotaResponse } from './agyUsageAdapter';

const TOKEN_FILE = join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
// Our own cache, deliberately distinct from the SwiftBar plugin's file so the
// two never race on writes.
const CREDS_CACHE_FILE = join(os.homedir(), '.gemini', 'antigravity-cli', '.happy-usage-creds.json');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
const USER_AGENT = 'happy-cli/agy-usage';

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface AgyQuotaClientDeps {
  readTextFile?: (path: string) => Promise<string>;
  writeTextFile?: (path: string, data: string) => Promise<void>;
  /** Returns the agy binary's printable strings (defaults to `strings -n 6`). */
  dumpBinaryStrings?: (binPath: string) => Promise<string>;
  fetch?: typeof fetch;
  resolveBin?: () => string;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface AgyQuotaClient {
  fetchQuota(): Promise<AgyQuotaResponse>;
}

export function createAgyQuotaClient(deps: AgyQuotaClientDeps = {}): AgyQuotaClient {
  const readTextFile = deps.readTextFile ?? ((p) => readFile(p, 'utf8'));
  // 0600: the cache holds the OAuth client secret, and agy's own token file
  // next to it is 0600 — don't be the loosest file in the directory.
  const writeTextFile = deps.writeTextFile ?? ((p, d) => writeFile(p, d, { encoding: 'utf8', mode: 0o600 }));
  const dumpBinaryStrings = deps.dumpBinaryStrings ?? defaultDumpBinaryStrings;
  const doFetch = deps.fetch ?? fetch;
  const resolveBin = deps.resolveBin ?? resolveAgyBin;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});

  let cachedToken: { accessToken: string; expiresAt: number } | null = null;

  async function readRefreshToken(): Promise<string> {
    const raw = await readTextFile(TOKEN_FILE);
    const rt = JSON.parse(raw)?.token?.refresh_token;
    if (typeof rt !== 'string' || !rt) {
      throw new Error('agy refresh_token not found (run `agy` once to log in)');
    }
    return rt;
  }

  async function loadCachedClient(): Promise<OAuthClient | null> {
    try {
      const parsed = JSON.parse(await readTextFile(CREDS_CACHE_FILE));
      if (typeof parsed?.clientId === 'string' && typeof parsed?.clientSecret === 'string') {
        return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
      }
    } catch {
      // no / invalid cache — fall back to scanning the binary
    }
    return null;
  }

  /** Cartesian product of client-id and secret candidates found in the binary. */
  async function extractClients(): Promise<OAuthClient[]> {
    const dump = await dumpBinaryStrings(toOpenablePath(resolveBin()));
    const clientIds = [...dump.matchAll(/[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com/g)].map((m) => m[0]);
    const secrets = [...dump.matchAll(/GOCSPX-[A-Za-z0-9_-]{28,}/g)].map((m) => m[0].slice(0, 35));
    const seen = new Set<string>();
    const pairs: OAuthClient[] = [];
    for (const clientId of clientIds) {
      for (const clientSecret of secrets) {
        const key = `${clientId}\0${clientSecret}`;
        if (!seen.has(key)) {
          seen.add(key);
          pairs.push({ clientId, clientSecret });
        }
      }
    }
    return pairs;
  }

  async function exchange(refreshToken: string, client: OAuthClient): Promise<{ accessToken: string; expiresIn: number }> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
    const res = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`token exchange failed: ${res.status}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json?.access_token) {
      throw new Error('token exchange returned no access_token');
    }
    return {
      accessToken: json.access_token,
      expiresIn: typeof json.expires_in === 'number' ? json.expires_in : 3600,
    };
  }

  async function mintAccessToken(): Promise<{ accessToken: string; expiresIn: number }> {
    const refreshToken = await readRefreshToken();
    const cached = await loadCachedClient();
    if (cached) {
      try {
        return await exchange(refreshToken, cached);
      } catch (e) {
        log(`cached agy OAuth client failed, rescanning binary: ${errMsg(e)}`);
      }
    }
    for (const client of await extractClients()) {
      let token: { accessToken: string; expiresIn: number };
      try {
        token = await exchange(refreshToken, client);
      } catch {
        continue; // try the next candidate pair
      }
      // Best-effort: a failed cache write must not discard the minted token —
      // it only costs a binary rescan on the next pull.
      try {
        await writeTextFile(
          CREDS_CACHE_FILE,
          JSON.stringify({ clientId: client.clientId, clientSecret: client.clientSecret }),
        );
      } catch (e) {
        log(`could not cache agy OAuth client: ${errMsg(e)}`);
      }
      return token;
    }
    throw new Error('no working OAuth client found in agy binary');
  }

  async function getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && cachedToken && cachedToken.expiresAt - 60_000 > now()) {
      return cachedToken.accessToken;
    }
    const { accessToken, expiresIn } = await mintAccessToken();
    cachedToken = { accessToken, expiresAt: now() + expiresIn * 1000 };
    return accessToken;
  }

  function requestQuota(accessToken: string): Promise<Response> {
    return doFetch(QUOTA_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
  }

  async function fetchQuota(): Promise<AgyQuotaResponse> {
    let res = await requestQuota(await getAccessToken());
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      // 429 too, not just auth failures: this endpoint throttles per access
      // token, so a freshly minted one gets a clean bucket (verified against
      // the same API from the menubar plugin, 2026-07-17).
      res = await requestQuota(await getAccessToken(true));
    }
    if (!res.ok) {
      throw new Error(`retrieveUserQuota failed: ${res.status}`);
    }
    return (await res.json()) as AgyQuotaResponse;
  }

  return { fetchQuota };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * `resolveAgyBin` returns a bare command name when agy is on PATH — enough to
 * spawn, since the OS resolves it, but `strings` needs a file it can open.
 */
function toOpenablePath(bin: string): string {
  if (bin.includes('/') || bin.includes('\\')) return bin;
  // execFile (no shell) with the platform's own lookup, mirroring
  // resolveAgyBin's probe; `where` may print several matches — take the first.
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return execFileSync(cmd, [bin], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
}

function defaultDumpBinaryStrings(binPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // stderr must be drained, not 'ignore': on this platform `strings` exits
    // non-zero when its stderr is redirected to /dev/null but exits clean when
    // it is consumed. And, like the reference plugin, we trust whatever stdout
    // we got rather than the exit code — a partial dump still carries the
    // OAuth client we need.
    const child = spawn('strings', ['-n', '6', binPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.stderr?.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      if (out.length > 0) resolve(out);
      else reject(new Error(`strings produced no output (exit ${code ?? 'null'})`));
    });
  });
}
