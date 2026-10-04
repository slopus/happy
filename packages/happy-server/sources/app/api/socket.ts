import { onShutdown } from "@/utils/shutdown";
import { Fastify } from "./types";
import { buildMachineActivityEphemeral, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { Server } from "socket.io";
import { createIsolatedRedisAdapter } from "./socket/createIsolatedRedisAdapter";
import { createRedisClient, isRedisConfigured } from "@/storage/createRedisClient";
import { log } from "@/utils/log";
import { auth } from "@/app/auth/auth";
import { BROWSER_SYNC_EXPIRES_AT, armBrowserSyncDeadline, authenticateBrowserSyncSocket } from "./socket/browserSyncSocketAuth";
import { getMetricsLabelsFromSocket, redisStreamInfoFailuresCounter, redisStreamLagMsGauge, redisStreamWriteFailuresCounter, redisStreamWriteDuration, socketioClusterPeersGauge, websocketConnectionsGauge, websocketEventsCounter } from "../monitoring/metrics2";
import { createLogThrottle, instrumentStreamWrites, readClusterPeerCount } from "../monitoring/redisHealth";
import { usageHandler } from "./socket/usageHandler";
import { rpcHandler } from "./socket/rpcHandler";
import { pingHandler } from "./socket/pingHandler";
import { sessionUpdateHandler } from "./socket/sessionUpdateHandler";
import { machineUpdateHandler } from "./socket/machineUpdateHandler";
import { artifactUpdateHandler } from "./socket/artifactUpdateHandler";
import { accessKeyHandler } from "./socket/accessKeyHandler";
import { terminalRelayHandler } from "./socket/terminalRelayHandler";
import { setTerminalSessionBackend, type TerminalSessionBackend } from "./socket/terminalSessions";
import { previewWsMachineHandler, registerPreviewWsClusterListeners } from "@/modules/preview/previewWebSocketRelay";
import { db } from "@/storage/db";
import { machineSocketIdentityExists } from "./socket/machineSocketAuth";
import { automationSocketHandler } from "./socket/automationSocketHandler";
import { markMachineOffline, markMachineOnline } from "@/app/presence/machinePresence";
import { evictSupersededMachineSockets } from "@/app/events/findMachineSockets";
import { wrapServerForPreviewSubdomainBypass } from "@/modules/preview/previewEngineIoGuard";
import { startManagedSocket } from "@/app/api/socket/managed/managedSocketServer";
import { setManagedRpcServer } from "@/app/api/socket/managed/managedDelivery";
import type { ManagedControlRuntime } from "@/app/managed/managedControlRuntime";
import { authenticateManagedDaemonSocket } from "@/app/api/socket/managedDaemonSocketAuth";
import { installManagedDaemonSocketGuard } from "@/app/api/socket/managedDaemonSocketGuard";
import { setManagedControlRuntime } from "@/app/api/socket/managedDaemonOutboundGuard";
import { installManagedDaemonRpcExecutor } from "@/app/api/socket/managedDaemonRpcRelay";
import type { ManagedDaemonClaims } from "@/app/auth/managedDaemonToken";

export function startSocket(app: Fastify, managedControl: ManagedControlRuntime | null = null) {
    // engine.io claims `/v1/updates` purely by path prefix, blind to Host —
    // so a preview-subdomain request for it would otherwise be swallowed by
    // engine.io instead of relayed to the previewed dev server the way every
    // other path already is (Fastify's rewriteUrl, api.ts). Wrapping the
    // server object here makes engine.io's own attach() behave as if those
    // specific requests never matched its path. See previewEngineIoGuard.ts.
    const io = new Server(wrapServerForPreviewSubdomainBypass(app.server), {
        cors: {
            origin: "*",
            methods: ["GET", "POST", "OPTIONS"],
            credentials: true,
            allowedHeaders: ["*"]
        },
        transports: ['websocket', 'polling'],
        pingTimeout: 45000,
        pingInterval: 15000,
        path: '/v1/updates',
        allowUpgrades: true,
        // engine.io's default behavior is to `socket.end()` any upgrade whose
        // path is not its own (`/v1/updates`) after `destroyUpgradeTimeout`.
        // The preview WebSocket relay (previewWebSocketRelay.ts) owns
        // `/v1/preview/:machineId/:port/*` upgrades on the same HTTP server, so
        // we opt out of engine.io tearing those foreign upgrades down. The
        // managed socket server below shares this HTTP server too, on its own
        // path, and needs the same.
        destroyUpgrade: false,
        upgradeTimeout: 10000,
        connectTimeout: 20000,
        serveClient: false, // Don't serve the client files
        // 100 MiB — matches the preview relay's 50 MiB body cap plus
        // base64 overhead (~33%) + envelope + headroom. Socket.IO's
        // default is 1 MiB which would cut off any non-trivial dev
        // bundle in proxy-http-request acks. See specs/remote-preview-relay/
        // Phase 4.
        maxHttpBufferSize: 100 * 1024 * 1024,
        // Brief-disconnect event replay. Lets socket.io replay missed events
        // from the streams adapter (restoreSession via the Redis stream) so
        // the client can skip the heavy REST re-fetch when
        // socket.recovered === true — web-ui narrows loadSessions() to skip
        // its merge/decrypt pass on a recovered reconnect (specs/
        // websocket-connection-state-recovery D1). Verified cross-replica via
        // deploy/integration-tests/missed-events.mjs and
        // specs/connection-state-recovery/smoke-recovery.mjs (100-round
        // XRANGE cap under sustained write load during recovery not hit at
        // the tested load — see spec for the caveat).
        connectionStateRecovery: {
            maxDisconnectionDuration: 2 * 60 * 1000,
        },
    });

    // Multi-process support: attach Redis streams adapter when Redis is configured
    if (isRedisConfigured(process.env)) {
        const streamClient = createRedisClient();

        // A failed bus write is otherwise invisible: socket.io-adapter's
        // publish() catches the XADD rejection into a debug() log. Count it
        // here so a pinned-to-replica client (-READONLY) is observable.
        const shouldLogWriteFailure = createLogThrottle(60_000);
        const shouldLogSlowWrite = createLogThrottle(60_000);
        instrumentStreamWrites(streamClient, (code, error) => {
            redisStreamWriteFailuresCounter.inc({ code });
            if (shouldLogWriteFailure(code)) {
                log({ module: 'websocket', level: 'error' },
                    `cluster bus write failed (${code}, throttled to 1/min) — cross-replica routing is degraded: ${error}`);
            }
        }, (result, seconds) => {
            redisStreamWriteDuration.observe({ result }, seconds);
            if (result === 'success' && seconds > 0.25 && shouldLogSlowWrite('slow')) {
                log({ module: 'websocket', level: 'warn' },
                    `cluster bus write slow (${Math.round(seconds * 1000)}ms, throttled to 1/min)`);
            }
        });

        io.adapter(createIsolatedRedisAdapter(streamClient, createRedisClient(), { maxLen: 200000, readCount: 2000 }));
        log({ module: 'websocket' }, 'Redis streams adapter enabled for multi-process support');

        // Terminal sessions must be resolvable from the replica the daemon is
        // attached to, which is not necessarily the one that opened them.
        // Uses its own client independently of the cluster bus reader/writer.
        setTerminalSessionBackend(createRedisClient() as unknown as TerminalSessionBackend);

        // Track stream reader lag: wrap onRawMessage to capture last-read offset,
        // then periodically compare against stream HEAD.
        let lastReadOffset = "0-0";
        const adapter = io.of("/").adapter as any;
        const origOnRawMessage = adapter.onRawMessage.bind(adapter);
        adapter.onRawMessage = (msg: any, offset: string) => {
            lastReadOffset = offset;
            return origOnRawMessage(msg, offset);
        };
        const shouldLogInfoFailure = createLogThrottle(60_000);
        setInterval(async () => {
            // Peers on the bus. This is the decisive signal: with replicas >= 2
            // a sustained 0 means fetchSockets() is silently answering
            // local-only, so half of every daemon lookup fails as
            // "RPC method not available".
            socketioClusterPeersGauge.set(await readClusterPeerCount(adapter));
            try {
                const info = await streamClient.xinfo("STREAM", "socket.io") as any[];
                const headId = String(info[info.indexOf("last-generated-id") + 1]);
                const headMs = parseInt(headId.split("-")[0]);
                const readMs = parseInt(lastReadOffset.split("-")[0]);
                redisStreamLagMsGauge.set(headMs - readMs);
            } catch (error) {
                // Was a bare `catch {}`. Swallowing it left the lag gauge
                // frozen at its last value, so a dead bus kept reporting a
                // plausible number for hours. Count + log instead.
                redisStreamInfoFailuresCounter.inc();
                if (shouldLogInfoFailure('xinfo')) {
                    log({ module: 'websocket', level: 'error' },
                        `cluster stream XINFO failed (throttled to 1/min) — redis_stream_lag_ms is now stale: ${error}`);
                }
            }
        }, 5000);
    }

    // Initialize event router with Socket.IO server instance
    eventRouter.init(io);

    // Preview WS frames whose browser socket is owned by a peer replica arrive
    // here via serverSideEmit. Registered once per process.
    registerPreviewWsClusterListeners(io);

    // Auth runs in middleware so it completes BEFORE the client's `connect`
    // event fires. Without this, the async verifyToken in the connection
    // callback creates a window where client events (rpc-register, rpc-call)
    // arrive before handlers are attached — and get silently dropped.
    io.use(async (socket, next) => {
        const token = socket.handshake.auth.token as string;
        const clientType = socket.handshake.auth.clientType as 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined;
        const sessionId = socket.handshake.auth.sessionId as string | undefined;
        const machineId = socket.handshake.auth.machineId as string | undefined;

        if (!token) {
            log({ module: 'websocket' }, `No token provided`);
            next(new Error('Missing authentication token'));
            return;
        }

        if (clientType === 'session-scoped' && !sessionId) {
            log({ module: 'websocket' }, `Session-scoped client missing sessionId`);
            next(new Error('Session ID required for session-scoped clients'));
            return;
        }

        if (clientType === 'machine-scoped' && !machineId) {
            log({ module: 'websocket' }, `Machine-scoped client missing machineId`);
            next(new Error('Machine ID required for machine-scoped clients'));
            return;
        }

        /*
         * A managed runtime's daemon presents a credential of its **own
         * purpose**, not an account bearer — that is the whole point of the
         * split, since the daemon runs code the customer's agent can influence.
         * Those tokens are signed under a different service, so
         * `auth.verifyToken` cannot verify one and must not be asked to.
         *
         * Two checks, and both are needed on **every** connect: the signature
         * says the token was issued here, and the grant row says it has not
         * been withdrawn or superseded since. A signature cannot express a
         * revocation, so a socket authenticated on the signature alone would
         * outlive the withdrawal that was supposed to end it.
         */
        const managedDaemon = await authenticateManagedDaemonSocket({
            handshake: { token, clientType, machineId },
            managedControl,
            now: Date.now(),
        });
        if (managedDaemon) {
            socket.data.userId = managedDaemon.accountId;
            socket.data.managedDaemon = managedDaemon;
            socket.data.clientType = clientType;
            socket.data.sessionId = sessionId;
            socket.data.machineId = machineId;
            socket.data.connectedAt = Date.now();
            socket.data.happyClient = socket.handshake.auth.happyClient as string
                || socket.handshake.headers['x-happy-client'] as string
                || undefined;
            next();
            return;
        }

        /*
         * A browser presents a credential of its own purpose, not the account
         * bearer. That is what makes "log this browser out" mean something on
         * the socket: the bearer is one value per account, shared with the CLI
         * and the phone, and nothing here can withdraw it.
         *
         * The credential is short-lived and the web app reissues it only while
         * that browser's login session is live. So the connection is also given
         * a deadline — a check that ran only at connect would leave a socket
         * authenticated by a credential that has since stopped being reissued.
         */
        const browserSync = await authenticateBrowserSyncSocket({
            handshake: { token, clientType },
            issuer: auth.browserSyncIssuer,
            now: Date.now(),
        });
        if (browserSync) {
            socket.data.userId = browserSync.accountId;
            socket.data.clientType = clientType;
            socket.data.sessionId = sessionId;
            socket.data.machineId = machineId;
            socket.data.connectedAt = Date.now();
            socket.data.happyClient = socket.handshake.auth.happyClient as string
                || socket.handshake.headers['x-happy-client'] as string
                || undefined;
            // 만료 시각만 남기고, 타이머는 connection 에서 건다. 여기서 걸면
            // connection state recovery 로 되살아난 소켓이 만료 없이 산다 —
            // 복구는 이 미들웨어를 건너뛰고, 앞선 disconnect 가 타이머를 이미
            // 지웠기 때문이다. `socket.data` 는 복구 때 그대로 돌아온다.
            socket.data[BROWSER_SYNC_EXPIRES_AT] = browserSync.expiresAt;
            next();
            return;
        }

        const verified = await auth.verifyToken(token);
        if (!verified) {
            // One message for every way authentication can fail. A caller
            // learning *which* way would learn whether a given credential or
            // grant exists.
            log({ module: 'websocket' }, `Invalid token provided`);
            next(new Error('Invalid authentication token'));
            return;
        }

        if (clientType === 'machine-scoped'
            && !await machineSocketIdentityExists(db, verified.userId, machineId!)) {
            log({ module: 'websocket' }, `Machine-scoped identity does not match a registered machine`);
            next(new Error('Invalid machine identity'));
            return;
        }

        socket.data.userId = verified.userId;
        socket.data.clientType = clientType;
        socket.data.sessionId = sessionId;
        socket.data.machineId = machineId;
        // Recency signal for picking between two live sockets of the same
        // daemon (a reconnect after a network flap leaves the dead one around
        // until engine.io gives up). The old code relied on Set insertion
        // order, which does not survive a cross-replica fetchSockets() —
        // `data` does, because the adapter ships it with the socket details.
        // See specs/relay-cross-replica-routing.
        socket.data.connectedAt = Date.now();
        socket.data.happyClient = socket.handshake.auth.happyClient as string
            || socket.handshake.headers['x-happy-client'] as string
            || undefined;
        next();
    });

    // Managed children connect to a separate server with no packet recovery.
    // The runtime is the one the API already built: a second call here would
    // derive a second key and accept tokens the first would not. Null is the
    // expected off state; anything else fails startup rather than leaving a
    // server that looks healthy while managed access is silently missing.
    const managedIo = startManagedSocket(app.server, {
        issuer: managedControl?.scopedTokens ?? null,
        adapter: managedControl && isRedisConfigured(process.env)
            // Its own stream: managed traffic and legacy traffic must not share
            // a bus that either side can read.
            ? createIsolatedRedisAdapter(createRedisClient(), createRedisClient(), {
                streamName: 'socket.io.managed', maxLen: 200000, readCount: 2000,
            }) as never
            : undefined,
    });
    setManagedRpcServer(managedIo);
    // The one runtime the API built. Registered rather than rebuilt: a second
    // construction would derive a second key and accept tokens the first would
    // not.
    setManagedControlRuntime(managedControl);
    // The recipient half of the daemon RPC relay. Installed on every replica:
    // the one that owns a runtime's socket is the only one that can say the
    // grant holds *and* emit in the same breath.
    installManagedDaemonRpcExecutor(io);
    eventRouter.initManaged(managedIo);
    if (managedControl && !managedIo) {
        throw new Error('Managed control is configured but the managed socket server did not start');
    }

    io.on("connection", (socket) => {
        // 새 연결과 복구된 연결이 같이 지나는 유일한 지점이다. 자격이 이미
        // 만료됐으면 여기서 끝난다.
        if (armBrowserSyncDeadline(socket as never, Date.now()) === 'expired') return;
        const userId = socket.data.userId as string;
        const clientType = socket.data.clientType as 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined;
        const sessionId = socket.data.sessionId as string | undefined;
        const machineId = socket.data.machineId as string | undefined;
        const labels = getMetricsLabelsFromSocket(socket);

        log({ module: 'websocket' }, `Token verified: ${userId}, clientType: ${clientType || 'user-scoped'}, client: ${labels.client}, sessionId: ${sessionId || 'none'}, machineId: ${machineId || 'none'}, socketId: ${socket.id}`);

        // Store connection based on type
        const metadata = { clientType: clientType || 'user-scoped', sessionId, machineId };
        const happyClient = socket.data.happyClient as string | undefined;
        let connection: ClientConnection;
        if (metadata.clientType === 'session-scoped' && sessionId) {
            connection = {
                connectionType: 'session-scoped',
                socket,
                userId,
                sessionId,
                happyClient
            };
        } else if (metadata.clientType === 'machine-scoped' && machineId) {
            connection = {
                connectionType: 'machine-scoped',
                socket,
                userId,
                machineId,
                happyClient
            };
        } else {
            connection = {
                connectionType: 'user-scoped',
                socket,
                userId,
                happyClient
            };
        }
        eventRouter.addConnection(userId, connection);
        websocketConnectionsGauge.inc({ type: connection.connectionType, ...labels });

        // Broadcast daemon online status
        if (connection.connectionType === 'machine-scoped') {
            const connectedAt = Date.now();
            // Broadcast daemon online
            const machineActivity = buildMachineActivityEphemeral(machineId!, true, connectedAt);
            eventRouter.emitEphemeral({
                userId,
                payload: machineActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });

            // specs/machine-active-recovery — 브로드캐스트만으로는 DB 의
            // Machine.active 가 false 인 채로 남는다. 끊김 경로가
            // active=false 를 영속화하므로 연결 경로도 대칭이어야 한다.
            // fire-and-forget: 이 쓰기가 실패해도 소켓은 살아 있어야 하고,
            // heartbeat flush 가 최대 35초 안에 같은 상태를 다시 기록한다.
            void markMachineOnline(userId, connection.machineId, connectedAt);

            /*
             * specs/machine-socket-duplicate-registration/ — one machine, one
             * socket. Overlapping handshakes from a single daemon can each
             * complete, and engine.io keeps every one of them in the machine
             * room until its own ping budget runs out (pingInterval 15s +
             * pingTimeout 45s). Work routed into a socket the daemon is no
             * longer reading from is never answered — the caller just waits out
             * its ack. Close the superseded ones now instead.
             *
             * Fire-and-forget: a cluster bus that cannot answer should cost a
             * stale socket, not this connection.
             */
            void evictSupersededMachineSockets(io, userId, connection.machineId, socket.id)
                .then((evicted) => {
                    if (evicted > 0) {
                        log({ module: 'websocket' }, `Evicted ${evicted} superseded machine socket(s) for machine ${connection.machineId}, keeping ${socket.id}`);
                    }
                })
                .catch((error) => {
                    log({ module: 'websocket', level: 'error' }, `Machine socket eviction failed for ${connection.machineId}: ${error}`);
                });
        }

        // Track app focus state for push notification routing.
        // State lives on socket.data — no external storage needed.
        // Read initial state from handshake to close the race window between
        // connect and the first async app-state event.
        const initialAppState = socket.handshake.auth.appState as string | undefined;
        if (initialAppState) {
            socket.data.appState = initialAppState === 'active' ? 'active' : 'background';
        }

        socket.on('app-state', (data: { state: string }) => {
            socket.data.appState = data?.state === 'active' ? 'active' : 'background';
        });

        socket.on('disconnect', async () => {
            websocketEventsCounter.inc({ event_type: 'disconnect', ...labels });

            // Cleanup connections
            eventRouter.removeConnection(userId, connection);
            websocketConnectionsGauge.dec({ type: connection.connectionType, ...labels });

            log({ module: 'websocket' }, `User disconnected: ${userId}`);

            // Broadcast daemon offline status
            if (connection.connectionType === 'machine-scoped') {
                const disconnectedAt = Date.now();
                const machineActivity = buildMachineActivityEphemeral(connection.machineId, false, disconnectedAt);
                eventRouter.emitEphemeral({
                    userId,
                    payload: machineActivity,
                    recipientFilter: { type: 'user-scoped-only' }
                });

                try {
                    const hasReplacementConnection = await eventRouter.hasMachineSocket(userId, connection.machineId);
                    if (!hasReplacementConnection) {
                        await markMachineOffline(userId, connection.machineId, disconnectedAt);
                    }
                } catch (error) {
                    // markMachineOffline 은 내부에서 DB 실패를 삼키므로,
                    // 여기 걸리는 건 사실상 hasMachineSocket (Redis 어댑터
                    // 조회) 실패다. 대체 연결 여부를 모르면 끄지 않는다 —
                    // 살아 있는 머신을 끄는 쪽이 더 나쁘고, 진짜로 죽었다면
                    // timeout.ts 의 10분 스윕이 정리한다.
                    log({ module: 'websocket', level: 'error' }, `Failed to resolve replacement machine socket on disconnect: ${error}`);
                }
            }
        });

        /*
         * Handlers, and **which** handlers depends on who this is.
         *
         * A managed runtime's daemon authenticated with a credential scoped to
         * one machine. It appears under the customer's account because the
         * Machine is theirs, but it is not the customer: it runs code the
         * agent can influence. So it gets what a runtime needs — machine RPC,
         * its own machine's state, liveness — and none of the handlers that
         * reach the account: session updates, artifacts, access keys, terminal
         * relay and usage all act on things this runtime was never given.
         *
         * Registering them and refusing inside would be a second boundary in a
         * place where the first one is easy to get right; not registering them
         * means the events simply have no listener.
         */
        const managedDaemon = socket.data.managedDaemon as ManagedDaemonClaims | undefined;
        if (managedDaemon && managedControl) {
            /*
             * Installed **before** the handlers, so nothing they do can happen
             * without passing it.
             *
             * The handlers below take a `userId` and act on whatever the
             * payload names. That is correct for a person's daemon and wrong
             * here: this socket's credential is scoped to one machine, and the
             * account it belongs to owns others. The guard pins the machine and
             * re-reads the grant on every event, so a withdrawal takes effect
             * on the next thing this socket does rather than whenever it
             * happens to reconnect.
             */
            const guard = installManagedDaemonSocketGuard({
                socket,
                claims: managedDaemon,
                token: socket.handshake.auth.token as string,
                managedControl,
            });
            socket.on('disconnect', () => guard.dispose());
        }
        rpcHandler(userId, socket, io);
        pingHandler(socket);
        machineUpdateHandler(userId, socket);
        if (!managedDaemon) {
            usageHandler(userId, socket);
            sessionUpdateHandler(userId, socket, connection);
            artifactUpdateHandler(userId, socket);
            accessKeyHandler(userId, socket);
            terminalRelayHandler(userId, socket);
        }
        if (connection.connectionType === 'machine-scoped') {
            automationSocketHandler(userId, connection.machineId, socket);
            // proxy-ws-* only ever fires on the replica the daemon is attached
            // to, so the dispatch has to be wired here rather than lazily at
            // tunnel-open time on whichever replica took the browser upgrade.
            previewWsMachineHandler(socket);
        }

        // Ready
        log({ module: 'websocket' }, `User connected: ${userId}`);
    });

    onShutdown('api', async () => {
        await Promise.all([io.close(), managedIo?.close()]);
    });
}
