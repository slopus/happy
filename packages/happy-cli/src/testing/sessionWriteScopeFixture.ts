/** Owns disposable real server/daemon processes and a loopback-only model endpoint. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { lookup } from 'node:dns/promises';
import { io } from 'socket.io-client';
import tweetnacl from 'tweetnacl';
import { bindRpcRequest, readBoundRpcResponse } from '@slopus/happy-wire';
import { decrypt, encrypt } from '@/api/encryption';
import { decisionBytes, type ScopeDecision, type ScopeRequest } from '@/daemon/sessionWriteScope';

export async function eventually<T>(read: () => Promise<T | undefined>, label: string, timeout = 30_000): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await read();
        if (value !== undefined) return value;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out: ${label}`);
}
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
async function waitExit(child: ChildProcess) {
    await eventually(async () => exited(child) ? true : undefined, 'owned process exit');
    if (child.exitCode !== 0 || child.signalCode !== null) throw new Error(`Unclean exit ${child.exitCode}/${child.signalCode}`);
}
async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return (server.address() as { port: number }).port;
}
export type StoredMessage = { id: string; seq: number; localId: string | null; content: { t: string; c: string } };
export type DaemonState = { pid: number; httpPort: number; controlSecret: string };

export class SessionWriteScopeFixture {
    readonly keys = generateKeyPairSync('ed25519');
    readonly seed = randomBytes(32);
    readonly accountBox = tweetnacl.box.keyPair();
    readonly machineKey = randomBytes(32);
    private readonly sessionKeys = new Map<string, Buffer>();
    readonly cli = process.cwd();
    readonly serverDirectory = resolve(this.cli, '../happy-server');
    readonly modelRequests: string[] = [];
    readonly failures: string[] = [];
    readonly logs: string[] = [];
    root = ''; home = ''; happyHome = ''; project = ''; otherProject = ''; tools = ''; otherTools = '';
    serverUrl = ''; token = ''; accountId = ''; state!: DaemonState;
    incarnation: string = randomUUID();
    daemon?: ChildProcess;
    server?: ChildProcess;
    private model?: Server;
    private temporaryDirectory = '';
    private environment: NodeJS.ProcessEnv = {};
    private serverEnvironment: NodeJS.ProcessEnv = {};
    private readonly ownedPids = new Set<number>();
    private readonly processes = new Set<ChildProcess>();

    constructor(readonly options: { provider: 'codex' | 'claude'; encryptionVariant: 'legacy' | 'dataKey' } = { provider: 'codex', encryptionVariant: 'legacy' }) {}
    get modelHost() { return process.platform === 'linux' ? 'scope-model.test' : '127.0.0.1'; }
    get modelName() { return this.options.provider === 'codex' ? 'gpt-5.1-codex' : 'claude-sonnet-4-6'; }
    get providerIdentityField() { return this.options.provider === 'codex' ? 'codexThreadId' : 'claudeSessionId'; }
    sessionKey(id: string) {
        const key = this.sessionKeys.get(id);
        if (!key) throw new Error('Fixture session key unavailable');
        return key;
    }
    private unwrapKey(wrapped: string): Buffer {
        const bytes = Buffer.from(wrapped, 'base64');
        if (bytes[0] !== 0) throw new Error('Unknown fixture key envelope');
        const key = tweetnacl.box.open(bytes.subarray(57), bytes.subarray(33, 57), bytes.subarray(1, 33), this.accountBox.secretKey);
        if (!key || key.length !== 32) throw new Error('Fixture account cannot open key envelope');
        return Buffer.from(key);
    }

    async start() {
        // A scope root must be a narrow real directory below the OS account home.
        this.root = await realpath(await mkdtemp(join(process.env.HAPPY_SCOPE_FIXTURE_PARENT ?? userInfo().homedir, '.scope-server-integration-')));
        this.home = join(this.root, 'home'); this.happyHome = join(this.home, '.happy');
        this.project = join(this.root, 'project'); this.otherProject = join(this.root, 'other-project');
        this.tools = join(this.root, 'tools'); this.otherTools = join(this.root, 'other-tools');
        const codexHome = join(this.home, '.codex');
        // AF_UNIX socket paths must fit even when the source worktree path is long.
        this.temporaryDirectory = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'scope-fixture-')));
        await Promise.all([this.home, this.happyHome, this.project, this.otherProject, this.tools, this.otherTools,
            codexHome, join(this.home, '.claude'), join(this.root, 'server')].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
        this.model = createServer(async (request, response) => {
            let body = '';
            for await (const chunk of request) body += chunk;
            if (request.url?.startsWith('/v1/messages/count_tokens')) {
                response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ input_tokens: 10 })); return;
            }
            const claude = request.url?.split('?')[0] === '/v1/messages';
            if (!claude && !request.url?.endsWith('/responses')) {
                this.failures.push(`Unexpected local model route ${request.url}`); response.writeHead(404).end(); return;
            }
            this.modelRequests.push(body);
            const id = `resp_${randomUUID()}`, itemId = `msg_${randomUUID()}`;
            // Select only the latest input's marker, not markers in prior conversation history.
            const markers = [...body.matchAll(/scope-marker-[a-z0-9-]+/g)];
            const text = `fixture reply ${markers.at(-1)?.[0] ?? 'no-marker'}`;
            const item = { id: itemId, type: 'message', status: 'completed', role: 'assistant',
                content: [{ type: 'output_text', text, annotations: [] }] };
            const result = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model: 'gpt-5.1-codex',
                status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const emit = (type: string, payload: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
            if (claude) {
                const message = { id: itemId, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
                    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
                emit('message_start', { message });
                emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
                emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
                emit('content_block_stop', { index: 0 });
                emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
                emit('message_stop', {}); response.end(); return;
            }
            emit('response.created', { response: { ...result, status: 'in_progress', output: [] } });
            emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
            emit('response.content_part.added', { item_id: itemId, output_index: 0, content_index: 0,
                part: { type: 'output_text', text: '', annotations: [] } });
            emit('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: text });
            emit('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text });
            emit('response.content_part.done', { item_id: itemId, output_index: 0, content_index: 0, part: item.content[0] });
            emit('response.output_item.done', { output_index: 0, item });
            emit('response.completed', { response: result }); response.end();
        });
        const modelPort = await listen(this.model);
        // Linux's sandbox proxy bypasses literal loopback in its separate network namespace.
        // The dedicated fixture alias must resolve only to this owned loopback endpoint.
        if ((await lookup(this.modelHost, { all: true })).some(address => address.address !== '127.0.0.1')) {
            throw new Error('Fixture model hostname must resolve only to 127.0.0.1');
        }
        await writeFile(join(codexHome, 'config.toml'), `model = "gpt-5.1-codex"\nmodel_provider = "scope_fixture"\nweb_search = "disabled"\n[model_providers.scope_fixture]\nname = "Local scope fixture"\nbase_url = "http://${this.modelHost}:${modelPort}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
        const reservation = createServer();
        const serverPort = await listen(reservation);
        await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
        this.serverUrl = `http://127.0.0.1:${serverPort}`;
        // An allowlist avoids ambient auth, provider/proxy endpoints and caller lineage.
        this.environment = { PATH: `${dirname(process.execPath)}:${process.env.PATH}`, HOME: this.home,
            TMPDIR: this.temporaryDirectory, LANG: 'en_US.UTF-8', HAPPY_HOME_DIR: this.happyHome,
            HAPPY_SERVER_URL: this.serverUrl, HAPPY_WEBAPP_URL: this.serverUrl, HAPPY_DISABLE_CAFFEINATE: '1',
            HAPPY_DAEMON_HEARTBEAT_INTERVAL: '500',
            CODEX_HOME: codexHome, OPENAI_API_KEY: 'fixture-local-only', NO_PROXY: process.platform === 'linux' ? '' : '127.0.0.1,localhost',
            HAPPY_BROWSER_BRIDGE_HOST: '127.0.0.1',
            ANTHROPIC_API_KEY: 'fixture-local-only', ANTHROPIC_BASE_URL: `http://${this.modelHost}:${modelPort}`,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            ...(process.env.HAPPY_CLAUDE_PATH ? { HAPPY_CLAUDE_PATH: process.env.HAPPY_CLAUDE_PATH } : {}) };
        this.serverEnvironment = { ...this.environment, TSX_TSCONFIG_PATH: join(this.serverDirectory, 'tsconfig.json'),
            HANDY_MASTER_SECRET: randomBytes(32).toString('hex'), DB_PROVIDER: 'pglite',
            DATA_DIR: join(this.root, 'server'), PGLITE_DIR: join(this.root, 'server/pglite'),
            HOST: '127.0.0.1', PORT: String(serverPort), METRICS_ENABLED: 'false', HAPPY_STANDALONE_CONTROL: 'stdin-v1' };
        const migration = this.launch(['--import', 'tsx', 'sources/standalone.ts', 'migrate'], this.serverDirectory, this.serverEnvironment);
        await waitExit(migration);
        await this.startServer();
        const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), this.seed]), type: 'pkcs8', format: 'der' });
        const challenge = randomBytes(32);
        const auth = await this.http('/v1/auth', { publicKey: Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x!, 'base64url').toString('base64'),
            challenge: challenge.toString('base64'), signature: sign(null, challenge, privateKey).toString('base64') });
        this.token = auth.body.token;
        this.accountId = JSON.parse(Buffer.from(this.token.split('.')[1], 'base64url').toString()).sub;
        await writeFile(join(this.happyHome, 'access.key'), JSON.stringify(this.options.encryptionVariant === 'legacy'
            ? { token: this.token, secret: this.seed.toString('base64') }
            : { token: this.token, encryption: { publicKey: Buffer.from(this.accountBox.publicKey).toString('base64'),
                machineKey: this.machineKey.toString('base64') } }), { mode: 0o600 });
        await writeFile(join(this.happyHome, 'settings.json'), JSON.stringify({ serverUrl: this.serverUrl }), { mode: 0o600 });
        await this.startDaemon();
    }
    private launch(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
        const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
        this.processes.add(child);
        child.on('error', error => this.failures.push(error.message));
        for (const stream of [child.stdout, child.stderr]) stream!.on('data', data => {
            this.logs.push(String(data)); if (this.logs.length > 1000) this.logs.shift();
        });
        return child;
    }
    async startServer() {
        this.server = this.launch(['--import', 'tsx', 'sources/standalone.ts', 'serve'], this.serverDirectory, this.serverEnvironment);
        await eventually(async () => {
            if (exited(this.server!)) throw new Error(`Server exited: ${this.logs.join('')}`);
            try { return (await fetch(this.serverUrl + '/health', { signal: AbortSignal.timeout(500) })).ok ? true : undefined; } catch { return undefined; }
        }, 'source standalone health');
    }
    async stopServer() { if (this.server && !exited(this.server)) { this.server.stdin!.end(); await waitExit(this.server); } }
    async startDaemon() {
        this.daemon = this.launch(['--no-warnings', '--no-deprecation', 'bin/happy.mjs', 'daemon', 'start-sync'], this.cli,
            { ...this.environment, HAPPY_WRITE_SCOPE_HOST_VERSION: '1', HAPPY_WRITE_SCOPE_HOST_ACCOUNT_ID: this.accountId,
                HAPPY_WRITE_SCOPE_HOST_INCARNATION: this.incarnation,
                HAPPY_WRITE_SCOPE_HOST_PUBLIC_KEY: this.keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
        this.state = await eventually(async () => {
            if (exited(this.daemon!)) throw new Error(`Daemon exited: ${this.logs.join('')}`);
            let state: DaemonState;
            try { state = JSON.parse(await readFile(join(this.happyHome, 'daemon.state.json'), 'utf8')); } catch { return undefined; }
            return state.pid === this.daemon!.pid && state.controlSecret ? state : undefined;
        }, 'owned daemon control state');
    }
    async control(path: string, body: unknown) {
        const response = await fetch(`http://127.0.0.1:${this.state.httpPort}${path}`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.state.controlSecret}` },
            body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
        return { status: response.status, body: await response.json() as any };
    }
    async discardApprovalResponse(request: ScopeRequest) {
        const response = await fetch(`http://127.0.0.1:${this.state.httpPort}/session-write-scope/decide`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.state.controlSecret}` },
            body: JSON.stringify(this.approval(request)), signal: AbortSignal.timeout(120_000) });
        // The caller receives no decision result and must reconcile through list, never repeat approval.
        await response.body?.cancel();
    }
    async http(path: string, body?: unknown) {
        const response = await fetch(this.serverUrl + path, { method: body === undefined ? 'GET' : 'POST',
            headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
        const result = { status: response.status, body: await response.json() as any };
        if (!response.ok) throw new Error(`Server ${path}: ${result.status}`);
        return result;
    }
    async children(): Promise<{ happySessionId: string; pid: number }[]> {
        const result = await this.control('/list', {});
        for (const child of result.body.children) this.ownedPids.add(child.pid);
        return result.body.children;
    }
    async spawnSession(directory: string, config: unknown): Promise<string> {
        return eventually(async () => {
            const result = await this.control('/spawn-session', { directory, agent: this.options.provider,
                environmentVariables: { HAPPY_PROJECT_SANDBOX_CONFIG: JSON.stringify(config) } });
            if (result.body.error === 'Daemon is initializing; retry the launch shortly') return undefined;
            if (result.status !== 200 || !result.body.success || !result.body.sessionId) throw new Error(`Spawn rejected: ${JSON.stringify(result)}`);
            await this.children();
            await this.session(result.body.sessionId);
            return result.body.sessionId as string;
        }, 'daemon ready and session spawned');
    }
    async resumeSession(sessionId: string): Promise<string> {
        await this.waitDaemonConnection(true);
        const machines = (await this.http('/v1/machines')).body;
        if (machines.length !== 1 || machines[0].accountId !== this.accountId) throw new Error('Unexpected fixture machine identity');
        const machineId = machines[0].id as string;
        const rpcKey = this.options.encryptionVariant === 'legacy' ? this.seed : this.unwrapKey(machines[0].dataEncryptionKey);
        if (!rpcKey.equals(this.options.encryptionVariant === 'legacy' ? this.seed : this.machineKey)) throw new Error('Fixture machine key mismatch');
        const socket = io(this.serverUrl, { path: '/v1/updates', transports: ['websocket'], reconnection: false,
            auth: { token: this.token, clientType: 'user-scoped' } });
        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Fixture account socket unavailable')), 5000);
                socket.once('connect', () => { clearTimeout(timer); resolve(); });
                socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
            });
            const method = 'resume-happy-session', nonce = randomBytes(16).toString('base64');
            const bound = bindRpcRequest({ method, scope: machineId, params: { sessionId }, issuedAt: Date.now(), nonce });
            const response = await socket.timeout(30_000).emitWithAck('rpc-call', { method: `${machineId}:${method}`,
                params: Buffer.from(encrypt(rpcKey, this.options.encryptionVariant, bound)).toString('base64') });
            if (!response.ok) throw new Error(`Fixture RPC failed: ${response.error}`);
            const opened = readBoundRpcResponse(decrypt(rpcKey, this.options.encryptionVariant, Buffer.from(response.result, 'base64')), nonce);
            if (!opened.ok) throw new Error(`Fixture RPC binding failed: ${opened.code}`);
            const result = opened.result as { type: string; sessionId: string; errorMessage?: string };
            if (result.type !== 'success') throw new Error(`Fixture resume rejected: ${result.errorMessage}`);
            await this.children();
            return result.sessionId;
        } finally { socket.disconnect(); }
    }
    async messages(id: string): Promise<StoredMessage[]> { return (await this.http(`/v3/sessions/${id}/messages?limit=500`)).body.messages; }
    decode(content: string, id: string) { return decrypt(this.sessionKey(id), this.options.encryptionVariant, Buffer.from(content, 'base64')); }
    async waitReply(id: string, marker: string) {
        return eventually(async () => {
            const messages = await this.messages(id);
            const reply = messages.find(message => {
                const decoded = this.decode(message.content.c, id);
                return decoded?.role === 'session' && decoded.content?.role === 'agent'
                    && decoded.content?.ev?.t === 'text' && decoded.content.ev.text === `fixture reply ${marker}`;
            });
            return reply && messages.some(message => message.seq > reply.seq && this.decode(message.content.c, id)?.content?.ev?.t === 'turn-end')
                ? reply : undefined;
        }, `stored reply and completed turn ${marker}`);
    }
    async session(id: string) {
        const sessions = (await this.http('/v1/sessions')).body.sessions;
        const session = sessions.find((value: { id: string }) => value.id === id);
        if (!session) throw new Error('Fixture session missing');
        this.sessionKeys.set(id, this.options.encryptionVariant === 'legacy' ? this.seed : this.unwrapKey(session.dataEncryptionKey));
        return { ...session, metadata: this.decode(session.metadata, id) };
    }
    async savedSession(id: string) {
        return JSON.parse(await readFile(join(this.happyHome, 'sessions.json'), 'utf8')).sessions[id];
    }
    async waitDaemonConnection(connected: boolean) {
        await eventually(async () => {
            const state = JSON.parse(await readFile(join(this.happyHome, 'daemon.state.json'), 'utf8'));
            return state.pid === this.daemon!.pid && state.socketConnected === connected ? true : undefined;
        }, `daemon connection ${connected}`);
    }
    async scopeRequest(id: string, path: string, kind: 'grant' | 'revoke' = 'grant') {
        return eventually(async () => {
            const result = await this.control('/session-write-scope', { action: 'request', sessionId: id, path, kind, description: 'Fixture tool access' });
            if (result.status === 200) return result.body.result as ScopeRequest;
            if (result.body.code !== 'SESSION_SCOPE_UNSUPPORTED') throw new Error(`Scope request rejected: ${result.body.code}`);
            return undefined;
        }, 'authenticated scope baseline');
    }
    async send(id: string, marker: string, localId = randomUUID()) {
        return (await this.http(`/v3/sessions/${id}/messages`, { messages: [{ localId,
            content: Buffer.from(encrypt(this.sessionKey(id), this.options.encryptionVariant, { role: 'user', content: { type: 'text', text: marker },
                meta: { permissionMode: 'yolo', model: this.modelName } })).toString('base64') }] })).body.messages[0] as StoredMessage;
    }
    approval(request: ScopeRequest) {
        const decision: ScopeDecision = { version: 1, requestId: request.id, digest: request.digest,
            incarnation: request.incarnation, accountId: request.accountId, machineId: request.machineId,
            sessionId: request.sessionId, action: 'allow' };
        return { decision, signature: sign(null, decisionBytes(decision), this.keys.privateKey).toString('base64url') };
    }
    async diagnostics() {
        const directory = join(this.happyHome, 'logs');
        const files = await readdir(directory).catch(() => []);
        const logs = await Promise.all(files.map(async file => {
            const lines = (await readFile(join(directory, file), 'utf8')).split('\n');
            return [file, ...lines.filter(line => /^\[\d/.test(line) && /drain|shutdown|Preserved session|resume|Failed|Error|freeze|EOF|stored|release|cleanup|flush|close|disconnect|handles/i.test(line)
                && !/encryption|Bearer|authorization|environment|metadata|snapshot/i.test(line)).slice(-45)].join('\n');
        }));
        const serverErrors = this.logs.flatMap(chunk => chunk.split('\n')).filter(line => /error|unknown argument|inconsistent|could not|convert|expected|found/i.test(line)
            && !/secret|token|bearer|authorization|environment/i.test(line)).map(line => line.replace(/[A-Za-z0-9+\/=_-]{40,}/g, '[redacted]'));
        const modelSummary = this.modelRequests.map(body => ({ model: JSON.parse(body).model, markers: [...body.matchAll(/scope-marker-[a-z0-9-]+/g)].map(match => match[0]) }));
        return [...logs, ...serverErrors.slice(-20), JSON.stringify(modelSummary)].join('\n');
    }
    async terminateFaultedFixtureSession(id: string) {
        const child = (await this.children()).find(value => value.happySessionId === id);
        if (!child || !this.ownedPids.has(child.pid)) throw new Error('Faulted fixture is not owned');
        // Explicit fault injection cleanup, not a successful drain or descendant-revocation proof.
        process.kill(-child.pid, 'SIGKILL');
        await eventually(async () => (await this.children()).some(value => value.pid === child.pid) ? undefined : true,
            'faulted fixture root forgotten', 5000);
    }
    async stopDaemon() {
        if (this.daemon && !exited(this.daemon)) {
            for (const child of await this.children()) {
                const stopped = await this.control('/stop-session', { sessionId: child.happySessionId });
                if (!stopped.body.stopped) throw new Error('Fixture session stop rejected');
                await eventually(async () => {
                    try { process.kill(child.pid, 0); return undefined; }
                    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
                }, 'fixture session exit', 5000);
            }
            const result = await this.control('/stop', {});
            if (result.status !== 200) throw new Error('Daemon stop rejected');
            await waitExit(this.daemon);
        }
    }
    async close() {
        const errors: unknown[] = [];
        try { await this.stopDaemon(); } catch (error) { errors.push(error); }
        try { await this.stopServer(); } catch (error) { errors.push(error); }
        for (const child of this.processes) if (!exited(child)) {
            errors.push(new Error('Owned fixture process required forced cleanup'));
            child.kill('SIGKILL');
            await eventually(async () => exited(child) ? true : undefined, 'forced fixture process exit', 5000).catch(error => errors.push(error));
        }
        // Fixture-only fallback; never signal untracked processes or count it as successful drain.
        for (const pid of this.ownedPids) {
            try {
                process.kill(pid, 0); errors.push(new Error(`Fixture session ${pid} survived shutdown`)); process.kill(-pid, 'SIGKILL');
                await eventually(async () => {
                    try { process.kill(pid, 0); return undefined; }
                    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
                }, 'forced fixture session exit', 5000);
            }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') errors.push(error); }
        }
        if (this.model) { this.model.closeAllConnections(); await new Promise<void>(resolve => this.model!.close(() => resolve())); }
        if (this.root) await rm(this.root, { recursive: true, force: true });
        if (this.temporaryDirectory) await rm(this.temporaryDirectory, { recursive: true, force: true });
        if (errors.length) throw new AggregateError(errors, `Fixture cleanup failed: ${errors.map(String).join('; ')}`);
    }
}
