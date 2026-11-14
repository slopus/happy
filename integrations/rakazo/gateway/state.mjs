import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sameSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function identityFor(subject, secret, realm = 'paws') {
  const identity = `${realm}\0${subject}`;
  const id = createHash('sha256').update(identity).digest('hex');
  return {
    email: `paws-${id}@paws.local`,
    password: createHmac('sha256', secret).update(identity).digest('base64url') + 'Aa1!',
    chiefId: `c${id.slice(0, 24)}`,
  };
}

export class GatewayState {
  constructor({ now = Date.now, ticketTtl = 60_000, leaseTtl = 12 * 60 * 60_000, maxEntries = 10_000 } = {}) {
    Object.assign(this, { now, ticketTtl, leaseTtl, maxEntries });
    this.tickets = new Map();
    this.leases = new Map();
    this.bootstraps = new Map();
    this.revocations = new Map();
  }
  prune() {
    for (const [key, entry] of this.tickets) if (entry.expiresAt <= this.now()) this.tickets.delete(key);
    for (const [key, entry] of this.leases) if (entry.expiresAt <= this.now()) this.revoke(key);
  }
  async bootstrap(subject, operation, signal) {
    signal?.throwIfAborted();
    let pending = this.bootstraps.get(subject);
    if (!pending) {
      pending = Promise.resolve().then(operation);
      this.bootstraps.set(subject, pending);
      // A cancelled waiter must not cancel another launch for the same account.
      void pending.finally(() => { if (this.bootstraps.get(subject) === pending) this.bootstraps.delete(subject); }).catch(() => {});
    }
    if (!signal) return pending;
    return new Promise((resolve, reject) => {
      const abort = () => { cleanup(); reject(signal.reason); };
      const cleanup = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
      pending.then((value) => { cleanup(); signal.aborted ? reject(signal.reason) : resolve(value); }, (error) => { cleanup(); reject(error); });
      if (signal.aborted) abort();
    });
  }
  issue(identity, launch) {
    this.prune();
    if (this.tickets.size >= this.maxEntries) throw new Error('Ticket capacity reached');
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.ticketTtl;
    this.tickets.set(ticket, { ...identity, ...launch, expiresAt });
    return { ticket, expiresAt };
  }
  redeem(ticket, parentOrigin, platform) {
    this.prune();
    const entry = this.tickets.get(ticket);
    if (!entry || entry.parentOrigin !== parentOrigin || entry.platform !== platform) return null;
    // Delete synchronously before minting the lease: parallel redemption has one winner.
    this.tickets.delete(ticket);
    if (this.leases.size >= this.maxEntries) throw new Error('Session capacity reached');
    const sessionKey = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.leaseTtl;
    this.leases.set(sessionKey, { ...entry, expiresAt });
    return { sessionKey, expiresAt, spaceId: entry.spaceId, locale: entry.locale, appearance: entry.appearance };
  }
  lease(key) {
    if (typeof key !== 'string') return null;
    const entry = this.leases.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) { this.revoke(key); return null; }
    return entry;
  }
  revoke(key) {
    this.leases.delete(key);
    const listeners = this.revocations.get(key);
    this.revocations.delete(key);
    for (const listener of [...(listeners ?? [])]) listener();
  }
  watchLease(key, onRevoke) {
    const lease = this.lease(key);
    if (!lease) { onRevoke(); return () => {}; }
    let listeners = this.revocations.get(key);
    if (!listeners) { listeners = new Set(); this.revocations.set(key, listeners); }
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      listeners.delete(revoked);
      if (!listeners.size && this.revocations.get(key) === listeners) this.revocations.delete(key);
    };
    const revoked = () => { cleanup(); onRevoke(); };
    listeners.add(revoked);
    // One expiry deadline, not a status-query loop. Sign-out also revokes synchronously.
    timer = setTimeout(() => this.revoke(key), Math.max(0, lease.expiresAt - this.now()));
    timer.unref?.();
    return cleanup;
  }
}

function cookiesFrom(response) {
  const cookies = response.headers.getSetCookie();
  const values = cookies.map((cookie) => cookie.split(';', 1)[0]);
  if (!values.some((value) => /session_token=/.test(value))) throw new Error('Rakazo did not issue a native session');
  return values.join('; ');
}

export class NativeSessionCache {
  constructor({ maxEntries = 1000 } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('Invalid native session cache capacity');
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }
  get(subject) {
    const entry = this.entries.get(subject);
    if (!entry) return undefined;
    this.entries.delete(subject);
    this.entries.set(subject, entry);
    return entry;
  }
  set(subject, entry) {
    this.entries.delete(subject);
    this.entries.set(subject, entry);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }
  delete(subject) { this.entries.delete(subject); }
}

export async function bootstrapNative({ apiUrl, authOrigin, subject, secret, realm, sessionCache, now = Date.now, fetcher = fetch }) {
  const identity = identityFor(subject, secret, realm);
  const request = (path, body, cookie, spaceId) => fetcher(new URL(path, apiUrl), {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/json', origin: authOrigin,
      ...(cookie ? { cookie } : {}), ...(spaceId ? { 'x-rakazo-space-id': spaceId } : {}) },
    body: JSON.stringify(body),
  });
  const validateSession = async (cookie, expectedUserId) => {
    const response = await fetcher(new URL('/api/auth/get-session?disableCookieCache=true', apiUrl), {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { cookie, origin: authOrigin },
    });
    if (response.status === 401 || response.status === 403) return null;
    // A rate limit or outage is not evidence that a session was revoked. Do not
    // amplify one by submitting more credential requests or bypassing native limits.
    if (!response.ok) throw new Error(`Native session verification unavailable (${response.status})`);
    const session = await response.json();
    if (session === null) return null;
    if (!session || typeof session !== 'object' || Array.isArray(session)
      || !session.session || typeof session.session !== 'object' || Array.isArray(session.session)
      || !session.user || typeof session.user !== 'object' || Array.isArray(session.user)) {
      throw new Error('Native session verification returned an invalid response');
    }
    if (session.user.email !== identity.email || typeof session.user.id !== 'string'
      || (expectedUserId && session.user.id !== expectedUserId)) {
      sessionCache?.delete(subject);
      throw new Error('Native session identity does not match the Paws account');
    }
    const expiresAt = Date.parse(session.session.expiresAt);
    if (!Number.isFinite(expiresAt)) throw new Error('Native session returned an invalid expiry');
    if (expiresAt <= now()) return null;
    return { cookie, userId: session.user.id, expiresAt };
  };
  let cached = sessionCache?.get(subject);
  let verified = cached ? await validateSession(cached.cookie, cached.userId) : null;
  if (!verified) {
    sessionCache?.delete(subject);
    const credentials = { email: identity.email, password: identity.password };
    let auth = await request('/api/auth/sign-in/email', credentials);
    if (auth.status === 401) auth = await request('/api/auth/sign-up/email', { ...credentials, name: 'Paws' });
    if (!auth.ok) throw new Error(`Native Rakazo account unavailable (${auth.status}); check admission or stable identity secret`);
    verified = await validateSession(cookiesFrom(auth));
    if (!verified) throw new Error('Native Rakazo did not establish a valid session');
  }
  sessionCache?.set(subject, verified);
  const { cookie } = verified;
  const rpc = async (procedure, input, spaceId) => {
    const response = await request(`/rpc/${procedure}`, { json: input }, cookie, spaceId);
    if (!response.ok) throw new Error(`Rakazo ${procedure} failed (${response.status})`);
    const payload = await response.json();
    if (payload.error || !('json' in payload)) throw new Error(`Rakazo ${procedure} returned an invalid response`);
    return payload.json;
  };
  const navigation = await rpc('spaces/list', {});
  const spaces = [navigation.current, ...(navigation.spaces ?? [])].filter(Boolean);
  const existingSpace = spaces.find((space) => space.bots?.some((bot) => bot.id === identity.chiefId));
  const spaceId = existingSpace?.id ?? navigation.current?.id;
  if (typeof spaceId !== 'string' || !spaceId) throw new Error('Native Rakazo account has no space');
  let chief = existingSpace?.bots.find((bot) => bot.id === identity.chiefId);
  if (!chief) chief = await rpc('bots/create', {
    id: identity.chiefId,
    name: 'Paws',
    description: 'Your chief bot',
    instructions: 'You are Paws, the user’s chief bot. Help the user directly and manage their bot team when asked. Use the configured local GPT model. Explain meaningful actions clearly and respect tool approval boundaries.',
    fleetManagement: true,
    computerMode: 'team',
    spawnKey: 'paws-chief-v1',
  }, spaceId);
  if (chief.id !== identity.chiefId) throw new Error('Unexpected native chief bot identity');
  if (!chief.pinned) await rpc('bots/update', { botId: chief.id, pinned: true }, spaceId);
  return { cookie, spaceId };
}
