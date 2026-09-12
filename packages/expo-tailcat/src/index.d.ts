export interface TunnelOptions {
  /** Secret tc-prefixed address received from the remote Tailcat server. */
  address: string;
  /** Explicitly served remote TCP port (1–65535). */
  port: number;
  /** Remote HTTP protocol. HTTPS validates the certificate against hostname. */
  scheme?: 'http' | 'https';
  /** Remote HTTP Host / TLS server name. Defaults to localhost. No DNS lookup is performed. */
  hostname?: string;
  /** Optional HTTPS DERP map URL; omit for embedded relay metadata or Tailcat's default map. */
  derpMapUrl?: string;
  /** Dial, TLS handshake and response-header timeout, 100–120000 ms. Default: 15000. */
  connectTimeoutMs?: number;
}

export interface Tunnel {
  readonly id: string;
  /** Secret loopback base URL, including a capability path and trailing slash. Append relative paths. */
  readonly httpUrl: string;
  /** Equivalent ws:// base URL; supports standard WebSocket upgrades. */
  readonly wsUrl: string;
  /** Idempotent; closes HTTP requests and active WebSockets. */
  close(): Promise<void>;
}

export function openTunnel(options: TunnelOptions): Promise<Tunnel>;
/** Also cancels pending openTunnel calls. */
export function closeAllTunnels(): Promise<void>;
/** Native code invalidates tunnels on backgrounding and Android network changes. Reopen when active. */
export function addTunnelsClosedListener(
  listener: (event: { reason: 'background' | 'networkChanged' }) => void,
): { remove(): void };