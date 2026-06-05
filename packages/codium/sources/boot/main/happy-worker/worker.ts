import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { parentPort, workerData } from 'node:worker_threads'
import tweetnacl from 'tweetnacl'
import type {
    HappyStateSnapshot,
    HappyWorkerMessage,
    HappyWorkerRequestWithId,
} from '../../../shared/happy-protocol'

if (!parentPort) {
    throw new Error('happy worker must be started via worker_threads')
}

type WorkerConfig = {
    storagePath: string
    serverUrl: string
    webappUrl: string
    clientId: string
}

type StoredCredentials = {
    schemaVersion: 1
    token: string
    secret: string
}

type LinkFlow = {
    keypair: tweetnacl.BoxKeyPair
    authUrl: string
    publicKey: string
    startedAt: number
    cancelled: boolean
}

type HappyEncryptionContext = {
    anonId: string
    contentPublicKey: Uint8Array
    contentSecretKey: Uint8Array
    masterBlobKey: Uint8Array
}

const config = workerData as WorkerConfig
const port = parentPort
const send = (m: HappyWorkerMessage) => port.postMessage(m)

let credentials: StoredCredentials | null = null
let client: HappyAuthenticatedClient | null = null
let linkFlow: LinkFlow | null = null
let state: HappyStateSnapshot = {
    status: 'starting',
    serverUrl: config.serverUrl,
    webappUrl: config.webappUrl,
    clientReady: false,
    updatedAt: Date.now(),
}

class HappyAuthenticatedClient {
    private constructor(
        private readonly cfg: WorkerConfig,
        private readonly auth: StoredCredentials,
        private readonly encryption: HappyEncryptionContext,
    ) {}

    static async create(
        cfg: WorkerConfig,
        auth: StoredCredentials,
    ): Promise<HappyAuthenticatedClient> {
        const secret = decodeBase64(auth.secret, 'base64url')
        const encryption = await createEncryptionContext(secret)
        return new HappyAuthenticatedClient(cfg, auth, encryption)
    }

    snapshot() {
        return {
            ready: true,
            serverUrl: this.cfg.serverUrl,
            accountId: parseTokenSub(this.auth.token),
            anonId: this.encryption.anonId,
            contentPublicKey: encodeBase64(this.encryption.contentPublicKey, 'base64url'),
        }
    }

    async request(path: string, init: RequestInit = {}): Promise<Response> {
        const headers = new Headers(init.headers)
        headers.set('Authorization', `Bearer ${this.auth.token}`)
        headers.set('X-Happy-Client', this.cfg.clientId)
        return fetch(`${this.cfg.serverUrl}${path}`, { ...init, headers })
    }
}

port.on('message', (msg: HappyWorkerRequestWithId) => {
    Promise.resolve()
        .then(() => handle(msg))
        .catch((err) => {
            const message = errString(err)
            setError(message)
            send({ kind: 'response', requestId: msg.requestId, ok: false, state, error: message })
        })
})

void boot()

async function boot(): Promise<void> {
    try {
        credentials = await readCredentials()
        client = credentials ? await HappyAuthenticatedClient.create(config, credentials) : null
        setState(snapshotForCredentials(credentials))
    } catch (err) {
        setError(`Failed to load Happy credentials: ${errString(err)}`)
    }
}

async function handle(msg: HappyWorkerRequestWithId): Promise<void> {
    if (msg.kind === 'getState') {
        respond(msg.requestId, state)
        return
    }
    if (msg.kind === 'clientStatus') {
        respond(msg.requestId, state, client?.snapshot() ?? { ready: false })
        return
    }
    if (msg.kind === 'createAccount') {
        await createAccount(msg.requestId)
        return
    }
    if (msg.kind === 'startLinkDevice') {
        await startLinkDevice(msg.requestId)
        return
    }
    if (msg.kind === 'restoreSecret') {
        await restoreSecret(msg.requestId, msg.secretKey)
        return
    }
    if (msg.kind === 'cancelAuth') {
        cancelLinkFlow()
        setState(snapshotForCredentials(credentials))
        respond(msg.requestId, state)
        return
    }
    if (msg.kind === 'logout') {
        cancelLinkFlow()
        credentials = null
        client = null
        await deleteCredentials()
        setState(snapshotForCredentials(null))
        respond(msg.requestId, state)
    }
}

async function createAccount(requestId: string): Promise<void> {
    cancelLinkFlow()
    setState({
        ...stateBase(),
        status: 'authenticating',
        clientReady: false,
        authFlow: { method: 'create-account', startedAt: Date.now() },
    })
    try {
        const secret = randomBytes(32)
        const token = await authGetToken(secret)
        await storeAuthenticated(token, secret)
        respond(requestId, state)
    } catch (err) {
        const message = errString(err)
        setError(message)
        send({ kind: 'response', requestId, ok: false, state, error: message })
    }
}

async function restoreSecret(requestId: string, secretKey: string): Promise<void> {
    cancelLinkFlow()
    setState({
        ...stateBase(),
        status: 'authenticating',
        clientReady: false,
        authFlow: { method: 'restore-secret', startedAt: Date.now() },
    })
    try {
        const normalized = normalizeSecretKey(secretKey)
        const secret = decodeBase64(normalized, 'base64url')
        if (secret.length !== 32) throw new Error('Invalid secret key length')
        const token = await authGetToken(secret)
        await storeAuthenticated(token, secret)
        respond(requestId, state)
    } catch (err) {
        const message = errString(err)
        setError(message)
        send({ kind: 'response', requestId, ok: false, state, error: message })
    }
}

async function startLinkDevice(requestId: string): Promise<void> {
    cancelLinkFlow()
    try {
        const keypair = tweetnacl.box.keyPair()
        const publicKey = encodeBase64(keypair.publicKey, 'base64url')
        const flow: LinkFlow = {
            keypair,
            publicKey,
            authUrl: `happy:///account?${publicKey}`,
            startedAt: Date.now(),
            cancelled: false,
        }
        await apiJson('/v1/auth/account/request', {
            publicKey: encodeBase64(keypair.publicKey),
        })
        linkFlow = flow
        setState({
            ...stateBase(),
            status: 'authenticating',
            clientReady: client !== null,
            authFlow: {
                method: 'link-device',
                authUrl: flow.authUrl,
                publicKey: flow.publicKey,
                startedAt: flow.startedAt,
            },
        })
        respond(requestId, state)
        void pollLinkFlow(flow)
    } catch (err) {
        const message = errString(err)
        setError(message)
        send({ kind: 'response', requestId, ok: false, state, error: message })
    }
}

async function pollLinkFlow(flow: LinkFlow): Promise<void> {
    while (!flow.cancelled && linkFlow === flow) {
        try {
            const data = await apiJson('/v1/auth/account/request', {
                publicKey: encodeBase64(flow.keypair.publicKey),
            })
            if (data.state === 'authorized') {
                if (typeof data.token !== 'string' || typeof data.response !== 'string') {
                    throw new Error('Happy auth response is missing token data')
                }
                const encrypted = decodeBase64(data.response)
                const secret = decryptBox(encrypted, flow.keypair.secretKey)
                if (!secret || secret.length !== 32) {
                    throw new Error('Failed to decrypt Happy account credentials')
                }
                linkFlow = null
                await storeAuthenticated(data.token, secret)
                return
            }
        } catch (err) {
            if (!flow.cancelled && linkFlow === flow) {
                linkFlow = null
                setError(`Happy link failed: ${errString(err)}`)
            }
            return
        }
        await delay(1000)
    }
}

async function storeAuthenticated(token: string, secret: Uint8Array): Promise<void> {
    credentials = {
        schemaVersion: 1,
        token,
        secret: encodeBase64(secret, 'base64url'),
    }
    await writeCredentials(credentials)
    client = await HappyAuthenticatedClient.create(config, credentials)
    setState(snapshotForCredentials(credentials))
}

async function createEncryptionContext(masterSecret: Uint8Array): Promise<HappyEncryptionContext> {
    const contentSeed = await deriveKey(masterSecret, 'Happy EnCoder', ['content'])
    const contentSecretKey = libsodiumBoxSecretKeyFromSeed(contentSeed)
    const contentPublicKey = tweetnacl.box.keyPair.fromSecretKey(contentSecretKey).publicKey
    const anonId = encodeHex(
        (await deriveKey(masterSecret, 'Happy Coder', ['analytics', 'id'])).slice(0, 8),
    ).toLowerCase()
    const masterBlobKey = await deriveKey(masterSecret, 'Happy Blobs', ['master'])
    return {
        anonId,
        contentPublicKey,
        contentSecretKey,
        masterBlobKey,
    }
}

function libsodiumBoxSecretKeyFromSeed(seed: Uint8Array): Uint8Array {
    const hashedSeed = new Uint8Array(createHash('sha512').update(seed).digest())
    return hashedSeed.slice(0, 32)
}

async function deriveKey(master: Uint8Array, usage: string, path: string[]): Promise<Uint8Array> {
    let state = await deriveSecretKeyTreeRoot(master, usage)
    for (const index of path) {
        state = await deriveSecretKeyTreeChild(state.chainCode, index)
    }
    return state.key
}

async function deriveSecretKeyTreeRoot(seed: Uint8Array, usage: string) {
    const digest = hmacSha512(new TextEncoder().encode(`${usage} Master Seed`), seed)
    return {
        key: digest.slice(0, 32),
        chainCode: digest.slice(32),
    }
}

async function deriveSecretKeyTreeChild(chainCode: Uint8Array, index: string) {
    const data = new Uint8Array([0x0, ...new TextEncoder().encode(index)])
    const digest = hmacSha512(chainCode, data)
    return {
        key: digest.slice(0, 32),
        chainCode: digest.slice(32),
    }
}

function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
    const hmac = createHmac('sha512', key)
    hmac.update(data)
    return new Uint8Array(hmac.digest())
}

async function authGetToken(secret: Uint8Array): Promise<string> {
    const keypair = tweetnacl.sign.keyPair.fromSeed(secret)
    const challenge = randomBytes(32)
    const signature = tweetnacl.sign.detached(challenge, keypair.secretKey)
    const data = await apiJson('/v1/auth', {
        challenge: encodeBase64(challenge),
        publicKey: encodeBase64(keypair.publicKey),
        signature: encodeBase64(signature),
    })
    if (typeof data.token !== 'string') {
        throw new Error('Happy authentication did not return a token')
    }
    return data.token
}

async function apiJson(path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(`${config.serverUrl}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Happy-Client': config.clientId,
        },
        body: JSON.stringify(body),
    })
    if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`Happy API ${response.status}: ${text || response.statusText}`)
    }
    return await response.json() as Record<string, unknown>
}

function decryptBox(encryptedBundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
    const ephemeralPublicKey = encryptedBundle.slice(0, 32)
    const nonce = encryptedBundle.slice(32, 32 + tweetnacl.box.nonceLength)
    const encrypted = encryptedBundle.slice(32 + tweetnacl.box.nonceLength)
    const decrypted = tweetnacl.box.open(encrypted, nonce, ephemeralPublicKey, recipientSecretKey)
    return decrypted ? new Uint8Array(decrypted) : null
}

async function readCredentials(): Promise<StoredCredentials | null> {
    try {
        const raw = JSON.parse(await readFile(config.storagePath, 'utf8')) as Partial<StoredCredentials>
        if (raw.schemaVersion !== 1 || typeof raw.token !== 'string' || typeof raw.secret !== 'string') {
            return null
        }
        const secret = decodeBase64(raw.secret, 'base64url')
        if (secret.length !== 32) return null
        return { schemaVersion: 1, token: raw.token, secret: raw.secret }
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
    }
}

async function writeCredentials(next: StoredCredentials): Promise<void> {
    await mkdir(dirname(config.storagePath), { recursive: true })
    const tmp = `${config.storagePath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
    await rename(tmp, config.storagePath)
}

async function deleteCredentials(): Promise<void> {
    try {
        await unlink(config.storagePath)
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
}

function snapshotForCredentials(auth: StoredCredentials | null): HappyStateSnapshot {
    if (!auth) {
        return {
            ...stateBase(),
            status: 'unconfigured',
            clientReady: false,
        }
    }
    return {
        ...stateBase(),
        status: 'authenticated',
        clientReady: true,
        accountId: parseTokenSub(auth.token),
        tokenExpiresAt: parseTokenExp(auth.token),
    }
}

function stateBase() {
    return {
        serverUrl: config.serverUrl,
        webappUrl: config.webappUrl,
        updatedAt: Date.now(),
    }
}

function setState(next: HappyStateSnapshot): void {
    state = next
    send({ kind: 'state', state })
}

function setError(message: string): void {
    state = {
        ...stateBase(),
        status: 'error',
        clientReady: client !== null,
        accountId: credentials ? parseTokenSub(credentials.token) : undefined,
        tokenExpiresAt: credentials ? parseTokenExp(credentials.token) : undefined,
        error: message,
    }
    send({ kind: 'state', state })
}

function respond(requestId: string, next: HappyStateSnapshot, value?: unknown): void {
    send({ kind: 'response', requestId, ok: true, state: next, value })
}

function cancelLinkFlow(): void {
    if (linkFlow) linkFlow.cancelled = true
    linkFlow = null
}

function encodeBase64(buffer: Uint8Array, variant: 'base64' | 'base64url' = 'base64'): string {
    const encoded = Buffer.from(buffer).toString('base64')
    if (variant === 'base64') return encoded
    return encoded.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function decodeBase64(encoded: string, variant: 'base64' | 'base64url' = 'base64'): Uint8Array {
    if (variant === 'base64url') {
        const normalized =
            encoded.replaceAll('-', '+').replaceAll('_', '/') +
            '='.repeat((4 - (encoded.length % 4)) % 4)
        return new Uint8Array(Buffer.from(normalized, 'base64'))
    }
    return new Uint8Array(Buffer.from(encoded, 'base64'))
}

function encodeHex(buffer: Uint8Array): string {
    return Buffer.from(buffer).toString('hex')
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function normalizeSecretKey(key: string): string {
    const trimmed = key.trim()
    if (/[-\s]/.test(trimmed) || trimmed.length > 50) {
        return encodeBase64(base32ToBytes(trimmed), 'base64url')
    }
    try {
        const bytes = decodeBase64(trimmed, 'base64url')
        if (bytes.length !== 32) throw new Error('Invalid secret key')
        return trimmed
    } catch {
        return encodeBase64(base32ToBytes(trimmed), 'base64url')
    }
}

function base32ToBytes(base32: string): Uint8Array {
    const cleaned = base32
        .toUpperCase()
        .replace(/0/g, 'O')
        .replace(/1/g, 'I')
        .replace(/8/g, 'B')
        .replace(/9/g, 'G')
        .replace(/[^A-Z2-7]/g, '')
    if (!cleaned) throw new Error('No valid secret key characters found')

    const bytes: number[] = []
    let buffer = 0
    let bufferLength = 0
    for (const char of cleaned) {
        const value = BASE32_ALPHABET.indexOf(char)
        if (value === -1) throw new Error('Invalid secret key character')
        buffer = (buffer << 5) | value
        bufferLength += 5
        if (bufferLength >= 8) {
            bufferLength -= 8
            bytes.push((buffer >> bufferLength) & 0xff)
        }
    }
    const out = new Uint8Array(bytes)
    if (out.length !== 32) {
        throw new Error(`Invalid secret key length: expected 32 bytes, got ${out.length}`)
    }
    return out
}

function parseTokenSub(token: string): string | undefined {
    return parseTokenPayload(token)?.sub
}

function parseTokenExp(token: string): number | undefined {
    const exp = parseTokenPayload(token)?.exp
    return typeof exp === 'number' ? exp * 1000 : undefined
}

function parseTokenPayload(token: string): { sub?: string; exp?: number } | undefined {
    const parts = token.split('.')
    if (parts.length !== 3) return undefined
    try {
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
            sub?: string
            exp?: number
        }
    } catch {
        return undefined
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function errString(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

process.on('uncaughtException', (err) => {
    send({ kind: 'fatal', error: errString(err) })
})
