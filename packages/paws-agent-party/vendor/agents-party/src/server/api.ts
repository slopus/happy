import { randomUUID } from 'node:crypto'
import { looksLikeCiphertext } from '../core/crypto.js'
import { HTTP_STATUS, PartyError } from '../core/errors.js'
import { HOST_NAME, isParticipantNameShaped } from '../core/names.js'
import { defaultSettings } from '../core/types.js'
import type { Message, PartySettings, Recipients } from '../core/types.js'
import type { Registry, RegistryEntry } from '../registry/registry.js'
import type { PartyStore } from '../store/store.js'
import { createWakeHub } from './wake.js'

/**
 * The party HTTP API as pure fetch-style handlers — the single server implementation for every deployment. The
 * package's standalone server (local web, self-hosted) and the site's routes both mount `createPartyApi(ctx)`; what
 * differs is the context: how the owner is authenticated, whether plaintext keys may be stored (zero-knowledge servers
 * accept only wrapped ones), and which registry backs it.
 *
 * Access model: party endpoints are open by knowledge of the party id (content is protected by the encryption key the
 * server never sees; addressing is routing, not secrecy). Owner endpoints — registry listing, party creation and
 * management, and anything under the name `host` (joining, speaking, leaving) — require owner auth.
 */

export interface Owner {
  /** `null` on single-owner servers (local, self-hosted); the user id on the site. */
  ownerId: string | null
}

export interface PartyApiContext {
  registry: Registry
  /** Pooled party stores: same instance per party for the server's lifetime. */
  store: (partyId: string) => Promise<PartyStore>
  /** Deletes the party's file from disk (registry row is handled by the API). */
  removeStore: (partyId: string) => Promise<void>
  /** Owner authentication: `null` when the request carries no valid owner credentials. */
  authOwner: (request: Request) => Promise<Owner | null>
  /** Zero-knowledge servers (our site) store only wrapped keys and reject plaintext ones. */
  zeroKnowledge: boolean
  /**
   * The owner's public key (for sealing party keys at creation) — the site returns the account's; single-owner servers
   * have none (keys are stored openly there). Omit for `null`.
   */
  ownerPublicKey?: (owner: Owner) => Promise<string | null>
  /** Aborted on server shutdown — pending long-polls return immediately instead of outliving their stores. */
  signal?: AbortSignal
  /** Creation guard (quotas, plan limits) — throw a PartyError (e.g. RATE_LIMITED) to refuse. */
  assertCreate?: (owner: Owner) => Promise<void>
  /**
   * Append guard, called before every message write with the PARTY's registry entry — the seam for per-owner quotas
   * (storage caps, daily message counts). Throw a PartyError (STORAGE_FULL, RATE_LIMITED) to refuse; the message
   * reaches the writing agent verbatim, so tell them what to do about it.
   */
  assertAppend?: (entry: RegistryEntry) => Promise<void>
  /**
   * How long a parked listen may sleep before a safety re-read (default 5000). Writes through this API wake listeners
   * instantly; the fallback covers writers this process cannot see. Lower it when such writers are expected — the
   * standalone server does (local-protocol clients write the party files directly, next to it).
   */
  listenFallbackMs?: number
  /**
   * How long a woken listen waits for the burst to finish before answering (default 400, `0` disables). A join and the
   * message that follows it are one human action but two rows, and answering the first alone wakes every listening
   * agent twice, at the price of a model turn each. See the listen branch.
   */
  listenSettleMs?: number
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const errorResponse = (error: unknown): Response => {
  if (error instanceof PartyError) {
    const status = HTTP_STATUS[error.code]
    return json(status, { code: error.code, message: error.message, status })
  }
  const message = error instanceof Error ? error.message : String(error)
  return json(500, { code: 'INTERNAL', message, status: 500 })
}

const readBody = async (request: Request): Promise<Record<string, unknown>> => {
  try {
    const text = await request.text()
    return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
  } catch {
    throw new PartyError('BAD_REQUEST', 'Invalid JSON body.')
  }
}

// Everything a message carries besides its body is plaintext metadata the server stores verbatim — so each field
// needs its own ceiling, or the 1 MB body cap is just a suggestion (a million recipients cost nothing to send).
// A party is a channel, not a mailing list: 64 addressees is already far past what a human or an agent addresses.
const MAX_RECIPIENTS = 64
const REPLY_TO_MAX_CHARS = 128 // a message id (uuid = 36); generous room for another deployment's id format
const DESC_MAX_CHARS = 200 // "reviews the diffs", not a bio

const parseTo = (to: unknown): Recipients => {
  if (to === undefined || to === '*') return '*'
  if (!Array.isArray(to) || to.length === 0 || !to.every((n) => typeof n === 'string')) {
    throw new PartyError('BAD_REQUEST', 'Invalid "to" — expected "*" or a non-empty array of names.')
  }
  if (to.length > MAX_RECIPIENTS) {
    throw new PartyError('BAD_REQUEST', `Too many recipients — address at most ${MAX_RECIPIENTS} names per message.`)
  }
  // Shape only: addressing someone who never joined is fine, and `host` is a legitimate ADDRESSEE (it is only
  // reserved as a sender), so the reserved-name rules must not apply here.
  if (!to.every((name) => isParticipantNameShaped(name))) {
    throw new PartyError('BAD_REQUEST', 'Invalid "to" — every recipient must look like a participant name.')
  }
  return to as string[]
}

/** Meta as returned to participants (no keys); the owner additionally gets `key`/`keyWrapped`. */
const publicMeta = (entry: RegistryEntry, owner: boolean): Record<string, unknown> => ({
  id: entry.id,
  title: entry.title,
  createdAt: entry.createdAt,
  lastMessageAt: entry.lastMessageAt,
  messagesCount: entry.messagesCount,
  sizeBytes: entry.sizeBytes,
  settings: entry.settings,
  ...(owner ? { key: entry.key, keyWrapped: entry.keyWrapped } : {}),
})

// Listeners are woken by the in-process hub on every write that lands through this API; the fallback re-read covers
// writes this process cannot see (another process over the same files, another instance) — where every write is an
// API request, it is pure insurance and can be lazy.
const LISTEN_FALLBACK_MS = 5000
/** A woken listen waits this long for the rest of the burst (a join and its message) before answering. */
const LISTEN_SETTLE_MS = 400
const LISTEN_DEFAULT_SEC = 25
const LISTEN_MAX_SEC = 55

// Matches the standalone server's whole-body cap; ciphertext is base64url, so chars ≈ bytes.
const MESSAGE_MAX_CHARS = 1_000_000

export type PartyApi = (request: Request) => Promise<Response | null>

/**
 * Returns a handler for requests under `/api/…`; resolves to `null` for paths it does not own (so a host app can mount
 * it in front of its own routes). Never throws — errors become `{ code, message, status }` JSON.
 */
export const createPartyApi = (ctx: PartyApiContext): PartyApi => {
  const hub = createWakeHub()
  ctx.signal?.addEventListener('abort', () => hub.wakeAll())

  /** The owner of the party, or a PARTY_NOT_FOUND that does not reveal whether the id exists to non-owners. */
  const getParty = async (partyId: string): Promise<RegistryEntry> => {
    const entry = await ctx.registry.get(partyId)
    if (entry === null) throw new PartyError('PARTY_NOT_FOUND', 'Party not found — check the ref.')
    return entry
  }

  /** Owner check for management endpoints: authenticated AND (single-owner server OR owns this party). */
  const requireOwnerOf = async (request: Request, entry: RegistryEntry): Promise<Owner> => {
    const owner = await ctx.authOwner(request)
    if (owner === null || (entry.ownerId !== null && owner.ownerId !== entry.ownerId)) {
      throw new PartyError('UNAUTHORIZED', 'This needs the owner — authenticate first.')
    }
    return owner
  }

  const touch = async (partyId: string): Promise<void> => {
    hub.wake(partyId) // the write is committed — end pending long-polls before the registry bookkeeping
    const store = await ctx.store(partyId)
    await ctx.registry.touch(partyId, await store.stats())
  }

  const handle = async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url)
    const segments = url.pathname.split('/').filter(Boolean) // ['api', 'parties', id?, action?]
    if (segments[0] !== 'api') return null

    // Who am I / how to seal for me — lets a CLI create parties whose keys land in the owner's cabinet.
    if (segments[1] === 'owner' && segments.length === 2 && request.method === 'GET') {
      const owner = await ctx.authOwner(request)
      if (owner === null) throw new PartyError('UNAUTHORIZED', 'This needs the owner — authenticate first.')
      const publicKey = (await ctx.ownerPublicKey?.(owner)) ?? null
      return json(200, { ownerId: owner.ownerId, publicKey })
    }

    // Capability probe — lets a client know it must never send a plaintext key here.
    if (segments[1] === 'server' && segments.length === 2 && request.method === 'GET') {
      return json(200, { zeroKnowledge: ctx.zeroKnowledge })
    }

    if (segments[1] !== 'parties' || segments.length > 4) return null
    const partyId = segments.at(2)
    const action = segments.at(3)
    const method = request.method

    // ── Owner endpoints: the registry ──────────────────────────────────────

    if (partyId === undefined) {
      const owner = await ctx.authOwner(request)
      if (owner === null) throw new PartyError('UNAUTHORIZED', 'This needs the owner — authenticate first.')

      if (method === 'GET') {
        const readPositiveInt = (name: string): number | undefined => {
          const raw = url.searchParams.get(name)
          if (raw === null) return undefined
          const value = Number(raw)
          if (!Number.isInteger(value) || value < 0) {
            throw new PartyError('BAD_REQUEST', `${name} expects a non-negative integer.`)
          }
          return value
        }
        const limit = readPositiveInt('limit')
        const offset = readPositiveInt('offset')
        const entries = await ctx.registry.list(owner.ownerId, {
          ...(limit === undefined ? {} : { limit }),
          ...(offset === undefined ? {} : { offset }),
        })
        return json(200, { parties: entries.map((entry) => publicMeta(entry, true)) })
      }

      if (method === 'POST') {
        await ctx.assertCreate?.(owner)
        const body = await readBody(request)
        // A zero-knowledge server never stores a plaintext key: it drops `key` and insists on the wrapped one.
        const key = !ctx.zeroKnowledge && typeof body.key === 'string' ? body.key : null
        const keyWrapped = typeof body.keyWrapped === 'string' ? body.keyWrapped : null
        if (ctx.zeroKnowledge && keyWrapped === null) {
          throw new PartyError('BAD_REQUEST', 'This server is zero-knowledge: party creation needs keyWrapped.')
        }
        if (key === null && keyWrapped === null) {
          throw new PartyError('BAD_REQUEST', 'A party needs its key: send key (self-hosted) or keyWrapped.')
        }
        const entry: RegistryEntry = {
          id: randomUUID(),
          title: typeof body.title === 'string' && body.title !== '' ? body.title : 'party',
          createdAt: Date.now(),
          lastMessageAt: null,
          messagesCount: 0,
          sizeBytes: 0,
          key,
          keyWrapped,
          settings: defaultSettings(),
          ownerId: owner.ownerId,
        }
        await ctx.registry.create(entry, owner.ownerId)
        await ctx.store(entry.id) // create the party file eagerly
        return json(200, publicMeta(entry, true))
      }

      // Bulk deletion — how an owner frees space without clicking through hundreds of parties. Selection is by last
      // activity (`lastMessageAt`, falling back to `createdAt`), matching the CLI's local `prune`.
      if (method === 'DELETE') {
        const all = url.searchParams.get('all') === 'true'
        const beforeRaw = url.searchParams.get('lastMessageBefore')
        if (!all && beforeRaw === null) {
          throw new PartyError('BAD_REQUEST', 'Bulk delete needs lastMessageBefore=<epoch ms> or all=true.')
        }
        const before = beforeRaw === null ? Number.POSITIVE_INFINITY : Number(beforeRaw)
        if (Number.isNaN(before)) throw new PartyError('BAD_REQUEST', 'lastMessageBefore expects epoch milliseconds.')
        const entries = await ctx.registry.list(owner.ownerId)
        const doomed = entries.filter((entry) => all || (entry.lastMessageAt ?? entry.createdAt) < before)
        let freedBytes = 0
        for (const entry of doomed) {
          freedBytes += entry.sizeBytes
          await ctx.removeStore(entry.id)
          await ctx.registry.remove(entry.id)
          hub.wake(entry.id) // parked listens fail fast, same as single deletion
        }
        return json(200, { deleted: doomed.length, freedBytes })
      }

      return null
    }

    // ── Party endpoints ─────────────────────────────────────────────────────

    if (action === undefined) {
      const entry = await getParty(partyId)

      if (method === 'GET') {
        const owner = await ctx.authOwner(request)
        const owns = owner !== null && (entry.ownerId === null || owner.ownerId === entry.ownerId)
        return json(200, publicMeta(entry, owns))
      }

      if (method === 'PATCH') {
        await requireOwnerOf(request, entry)
        const body = await readBody(request)
        if (typeof body.title === 'string' && body.title !== '') await ctx.registry.rename(partyId, body.title)
        if (typeof body.settings === 'object' && body.settings !== null) {
          const raw = body.settings as Record<string, unknown>
          if ('joinPolicy' in raw && raw.joinPolicy !== 'open') {
            throw new PartyError('BAD_REQUEST', 'Unknown joinPolicy — only "open" exists today.')
          }
          const settings: PartySettings = {
            ...entry.settings,
            ...(raw.joinPolicy === 'open' ? { joinPolicy: 'open' as const } : {}),
          }
          await ctx.registry.updateSettings(partyId, settings)
        }
        return json(200, publicMeta((await getParty(partyId)) satisfies RegistryEntry, true))
      }

      if (method === 'DELETE') {
        await requireOwnerOf(request, entry)
        await ctx.removeStore(partyId)
        await ctx.registry.remove(partyId)
        hub.wake(partyId) // parked listens fail fast with PARTY_NOT_FOUND instead of sleeping out their fallback
        return json(200, { ok: true })
      }

      return null
    }

    const entry = await getParty(partyId) // 404 before touching the store
    const store = await ctx.store(partyId)
    // `host` is trustworthy by construction: only THIS party's owner may join or speak under it.
    const requireHostRights = async (name: string): Promise<boolean> => {
      if (name.toLowerCase() !== HOST_NAME) return false
      await requireOwnerOf(request, entry)
      return true
    }

    if (method === 'POST' && action === 'join') {
      const body = await readBody(request)
      const name = typeof body.name === 'string' ? body.name : ''
      const owner = await requireHostRights(name)
      if (typeof body.desc === 'string' && body.desc.length > DESC_MAX_CHARS) {
        throw new PartyError('BAD_REQUEST', `"desc" is a one-liner — at most ${DESC_MAX_CHARS} characters.`)
      }
      const participant = await store.join(name, {
        ...(typeof body.desc === 'string' ? { desc: body.desc } : {}),
        owner,
      })
      await touch(partyId)
      return json(200, { participant })
    }

    if (method === 'POST' && action === 'leave') {
      const body = await readBody(request)
      if (typeof body.name !== 'string') throw new PartyError('BAD_REQUEST', 'Missing "name".')
      // Marking the HOST as gone is an owner action, exactly like joining or speaking as one: `host` is the only name
      // the model promises anything about, and a forged "host left" would break that promise. Every other name is
      // still self-asserted — see the "unauthenticated leave" trade-off in dev/docs/api.md.
      await requireHostRights(body.name)
      await store.leave(body.name)
      await touch(partyId)
      return json(200, { ok: true })
    }

    if (method === 'POST' && action === 'messages') {
      const body = await readBody(request)
      if (typeof body.from !== 'string') throw new PartyError('BAD_REQUEST', 'Missing "from".')
      if (typeof body.text !== 'string') throw new PartyError('BAD_REQUEST', 'Missing "text".')
      if (body.text.length > MESSAGE_MAX_CHARS) {
        throw new PartyError('BAD_REQUEST', 'Message too large — the limit is 1 MB per message.')
      }
      await requireHostRights(body.from)
      // The server can't read a body, but it can refuse one that provably isn't a message envelope — a client that
      // forgot to encrypt would otherwise poison the party with text nobody can decrypt. Not a spam filter: see the
      // JSDoc on looksLikeCiphertext. (join/leave events carry `text: ''` and never come through here.)
      if (!looksLikeCiphertext(body.text)) {
        throw new PartyError('BAD_REQUEST', 'Message bodies are encrypted — expected base64url(iv ‖ ciphertext).')
      }
      if (typeof body.replyTo === 'string' && body.replyTo.length > REPLY_TO_MAX_CHARS) {
        throw new PartyError('BAD_REQUEST', `"replyTo" is a message id — at most ${REPLY_TO_MAX_CHARS} characters.`)
      }
      await ctx.assertAppend?.(entry)
      const message = await store.append({
        from: body.from,
        to: parseTo(body.to),
        kind: 'message',
        text: body.text,
        ...(typeof body.replyTo === 'string' ? { replyTo: body.replyTo } : {}),
      })
      await touch(partyId)
      return json(200, { message })
    }

    if (method === 'GET' && action === 'messages') {
      const since = url.searchParams.get('since') ?? undefined
      const before = url.searchParams.get('before') ?? undefined
      const rawLimit = url.searchParams.get('limit')
      const limit = rawLimit === null ? undefined : Number(rawLimit)
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        throw new PartyError('BAD_REQUEST', 'limit expects a positive integer.')
      }
      const viewer = url.searchParams.get('for') ?? undefined
      const messages = await store.read({
        ...(since === undefined ? {} : { since }),
        ...(before === undefined ? {} : { before }),
        ...(limit === undefined ? {} : { limit }),
        ...(viewer === undefined ? {} : { for: viewer }),
      })
      return json(200, { messages })
    }

    if (method === 'GET' && action === 'listen') {
      let since = url.searchParams.get('since') ?? undefined
      const viewer = url.searchParams.get('for')
      if (viewer === null) throw new PartyError('BAD_REQUEST', 'listen needs ?for=<your-name>.')
      // `all=1` is the OWNER's view, the same one `GET /messages` gives when it is asked for no viewer: the whole
      // party, side conversations between two agents included. Without it an owner watching the party never sees an
      // addressed message live — the filter hides it AND the poll never ends on it — and the message only turns up
      // when the page is reloaded into the unfiltered history. `for` still says who is asking, because that is what
      // decides which messages are "someone else's" and therefore worth waking for.
      const view = url.searchParams.get('all') === '1' ? {} : { for: viewer }
      // No cursor means "from now", not "from the beginning": without this the first read returns the whole history,
      // any old message from somebody else ends the poll immediately, and `listen` degrades into `read` — which is the
      // opposite of what it is for. A caller that wants the backlog asks `read` for it.
      if (since === undefined) {
        since = (await store.read(view)).at(-1)?.cursor
      }
      const timeoutSec = Math.min(
        LISTEN_MAX_SEC,
        Math.max(1, Number(url.searchParams.get('timeoutSec')) || LISTEN_DEFAULT_SEC),
      )
      const deadline = Date.now() + timeoutSec * 1000
      while (ctx.signal?.aborted !== true) {
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) break
        // Park BEFORE reading, so a write landing mid-read still wakes this poll instead of slipping past it.
        const woke = hub.wait(partyId, Math.min(ctx.listenFallbackMs ?? LISTEN_FALLBACK_MS, remainingMs))
        // Full gapless batch from the caller's own `since` — a foreign message is what ends the long-poll.
        let messages: Message[]
        try {
          messages = await store.read({ ...view, ...(since === undefined ? {} : { since }) })
        } catch (error) {
          // The party may have been deleted under this poll — answer with the truth, not a raw driver error.
          if ((await ctx.registry.get(partyId)) === null) {
            throw new PartyError('PARTY_NOT_FOUND', 'Party not found — check the ref.')
          }
          throw error
        }
        if (messages.some((m) => m.from !== viewer)) {
          // Let a burst settle before answering. Things arrive in pairs here: a participant joins and speaks in the
          // same breath (the web owner does it in under half a second), and answering the join alone wakes every
          // listener twice for one human action — each wake costing a whole model turn. One extra beat of latency
          // buys them one wake and the full picture.
          const settleMs = ctx.listenSettleMs ?? LISTEN_SETTLE_MS
          if (settleMs > 0 && Date.now() + settleMs < deadline) {
            await new Promise((resolve) => setTimeout(resolve, settleMs))
            const settled = await store.read({ ...view, ...(since === undefined ? {} : { since }) })
            if (settled.length > messages.length) {
              return json(200, { messages: settled })
            }
          }
          return json(200, { messages })
        }
        await woke
      }
      return json(200, { messages: [] as Message[] })
    }

    if (method === 'GET' && action === 'participants') {
      return json(200, { participants: await store.participants() })
    }

    return null
  }

  return async (request) => {
    try {
      return await handle(request)
    } catch (error) {
      return errorResponse(error)
    }
  }
}
