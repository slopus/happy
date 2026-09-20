import type { ServerOptions } from "socket.io";

/**
 * The Socket.IO configuration the API server runs with. Kept in its own module
 * so tests can boot the exact production transport configuration without
 * importing the server's auth and storage graph.
 */
export const socketServerOptions: Partial<ServerOptions> = {
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
    upgradeTimeout: 10000,
    connectTimeout: 20000,
    serveClient: false, // Don't serve the client files
    // Session metadata is end-to-end encrypted and travels as one base64
    // packet. Rig's composer draft alone may hold 1,000,000 characters of
    // text, which encrypts and encodes past Engine.IO's 1,000,000-byte
    // default, so large valid drafts could never synchronize. 8 MiB covers
    // the worst case (see the Happy module README in happy-agent).
    maxHttpBufferSize: 8 * 1024 * 1024,
    // Brief-disconnect event replay. Currently OFF to preserve parity with
    // pre-multi-process prod behavior — clients fall through to the full
    // REST re-fetch path on every reconnect (apiSocket.ts onReconnected
    // listener). Enabling this lets socket.io replay missed events from
    // the streams adapter (which implements restoreSession via the Redis
    // stream) so the client can skip the heavy refetch when
    // socket.recovered === true. Verified working cross-replica via
    // deploy/integration-tests/missed-events.mjs (event #2 fired during a
    // forced engine.close() arrived after auto-reconnect, recovered=true).
    // Ship parity first; turn this on as a follow-up.
    // connectionStateRecovery: {
    //     maxDisconnectionDuration: 2 * 60 * 1000,
    // },
};
