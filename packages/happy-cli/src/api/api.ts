import axios from 'axios'
import { logger } from '@/ui/logger'
import type { AgentState, CreateSessionResponse, Metadata, Session, Machine, MachineMetadata, DaemonState } from '@/api/types'
import { ApiSessionClient } from './apiSession';
import { ApiMachineClient } from './apiMachine';
import { decodeBase64, encodeBase64, getRandomBytes, encrypt, decrypt, wrapDataEncryptionKey, buildMachineKeyEnvelopes } from './encryption';
import { PushNotificationClient } from './pushNotifications';
import { configuration } from '@/configuration';
import chalk from 'chalk';
import { Credentials } from '@/persistence';
import { connectionState, isNetworkError, isConnectivityError, connectionErrorCode } from '@/utils/serverConnectionErrors';
import { applySessionUrlEnv } from '@/utils/sessionUrlEnv';
import type { ManagedAttachment } from '@/managed/managedSessionAttach';

/**
 * Who this client is.
 *
 * The two are genuinely different principals, not one shape with some fields
 * missing: an account holds encryption material and can create sessions and
 * machines; a managed session holds a bearer scoped to one session that was
 * created for it. Modelling the second as a `Credentials` with holes in it
 * would let account-only code compile against something that cannot serve it.
 */
type ApiPrincipal =
  | { kind: 'account'; credential: Credentials }
  | { kind: 'managed-session'; attachment: ManagedAttachment }
  /**
   * The daemon of a managed runtime.
   *
   * A third principal, and it has to be: it holds a machine-scoped bearer and
   * the raw key of a Machine **somebody else registered**. It is not an account
   * — it has no account bearer and cannot create machines or sessions — and it
   * is not a managed session, which is scoped to one session it did not create.
   * Modelling it as either would give it a member that must never work here:
   * as an account it could register a machine and push to the account, and as a
   * session it could not read the machine it is supposed to be.
   */
  | {
    kind: 'managed-machine';
    machineId: string;
    token: string;
    /** The raw machine key the parent wrapped. Used to read, never re-wrapped. */
    machineKey: Uint8Array;
  };

export class ApiClient {

  static async create(credential: Credentials) {
    return new ApiClient({ kind: 'account', credential });
  }

  /**
   * A client for a session this process did not create.
   *
   * It holds a bearer scoped to one session and nothing else. There is no
   * account credential here — not a stand-in, not a cast — so the
   * account-shaped members are simply unreachable: `accountCredential()`
   * refuses, and the paths that need account encryption material or a push
   * registration go through it.
   */
  static managed(attachment: ManagedAttachment) {
    return new ApiClient({ kind: 'managed-session', attachment });
  }

  private readonly principal: ApiPrincipal;
  private readonly pushClient: PushNotificationClient | null;

  private constructor(principal: ApiPrincipal) {
    this.principal = principal
    // Push registration is an **account** capability. A managed runtime must
    // not register for the customer's notifications: its bearer is scoped to
    // this machine, and pushing from it would put runtime activity into the
    // account's notification stream as if the person had done it.
    this.pushClient = principal.kind === 'account'
      ? new PushNotificationClient(principal.credential.token, configuration.serverUrl)
      : null
  }

  /**
   * A client for a Machine the trusted parent already registered.
   *
   * It never creates: `getOrCreateMachine` refuses for this principal, and the
   * attach path below reads. Registration would either fail (the bearer is not
   * the account's) or, worse, overwrite key material the server treats as
   * write-once — after which nothing could read the machine again.
   */
  static managedMachine(input: {
    machineId: string;
    token: string;
    machineKey: Uint8Array;
    /** The Happy this credential was issued for, as the parent recorded it. */
    serverOrigin: string;
  }) {
    /*
     * The credential names its server, and this process talks to whatever
     * `configuration.serverUrl` says. Checked **here**, before any request:
     * a bearer sent to a host it was not issued for is a bearer handed to
     * somebody else, and discovering the mismatch from a failed request would
     * mean it had already been sent. Failing at construction also makes it a
     * startup error rather than an intermittent one.
     */
    const configured = new URL(configuration.serverUrl).origin;
    if (new URL(input.serverOrigin).origin !== configured) {
      throw new Error('this managed credential was issued for a different server');
    }
    return new ApiClient({
      kind: 'managed-machine',
      machineId: input.machineId,
      token: input.token,
      machineKey: input.machineKey,
    });
  }

  /**
   * Create a new session or load existing one with the given tag
   */
  /**
   * The account this client acts for, or a refusal.
   *
   * Reached only by code that genuinely needs account material. A managed
   * session has none, and saying so here is the whole point of the split.
   */
  private accountCredential(): Credentials {
    if (this.principal.kind !== 'account') {
      throw new Error('this operation needs an account credential; a managed session has none');
    }
    return this.principal.credential;
  }

  /** The bearer this client presents, whichever principal it is. */
  private bearer(): string {
    if (this.principal.kind === 'account') return this.principal.credential.token;
    if (this.principal.kind === 'managed-machine') return this.principal.token;
    return this.principal.attachment.scopedToken;
  }

  /**
   * Reads the Machine this runtime **is**, and refuses anything else.
   *
   * Three things it deliberately does not do:
   *
   *  - **It does not create.** The Machine exists; the parent registered it
   *    with key material the server treats as write-once.
   *  - **It does not derive or wrap keys.** The key arrives from the parent
   *    through the protected credential. Deriving one here would produce a key
   *    the server never stored, and the machine would be unreadable forever.
   *  - **It does not fall back offline.** The ordinary path can synthesise a
   *    local Machine when the server is unreachable, which is right for a
   *    laptop and wrong here: a runtime that proceeded on a synthesised machine
   *    would answer the parent about a registration that does not exist.
   *
   * The id is compared, not adopted: a response describing another Machine is
   * the one case where continuing would attach this runtime to somebody else's.
   */
  async attachRegisteredMachine(): Promise<Machine> {
    if (this.principal.kind !== 'managed-machine') {
      throw new Error('attaching to a registered machine needs a managed runtime credential');
    }
    const { machineId, machineKey } = this.principal;
    const response = await axios.get(
      `${configuration.serverUrl}/v1/machines/${encodeURIComponent(machineId)}`,
      {
        headers: {
          'Authorization': `Bearer ${this.bearer()}`,
          'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`,
        },
        timeout: 60000,
      },
    );
    const raw = response.data?.machine;
    if (!raw || raw.id !== machineId) {
      throw new Error('the server returned a different machine than this runtime is');
    }
    return {
      id: raw.id,
      encryptionKey: machineKey,
      // The parent wrapped a data key for this Machine; there is no legacy
      // secret on a managed runtime and nothing here may invent one.
      encryptionVariant: 'dataKey',
      metadata: raw.metadata ? decrypt(machineKey, 'dataKey', decodeBase64(raw.metadata)) : null,
      metadataVersion: raw.metadataVersion || 0,
      daemonState: raw.daemonState
        ? decrypt(machineKey, 'dataKey', decodeBase64(raw.daemonState))
        : null,
      daemonStateVersion: raw.daemonStateVersion || 0,
    };
  }

  async getOrCreateSession(opts: {
    tag: string,
    metadata: Metadata,
    state: AgentState | null,
    /**
     * A session key the caller chose, with its envelope wrapped to the account public key.
     *
     * For a parent that creates the session and hands the key to someone else (the daemon's
     * channel host): it must know the key the session is sealed with, so this call uploads
     * exactly these bytes instead of minting its own. Legacy accounts have no per-session key.
     */
    dataKey?: { key: Uint8Array, wrapped: Uint8Array },
  }): Promise<Session | null> {
    if (this.principal.kind === 'managed-session') {
      // Refused here rather than at the server: a managed run that reached
      // this point would create a session sealed with a key its parent never
      // saw, and nothing downstream could read the result.
      throw new Error('managed sessions are created by the parent, not by this process');
    }

    // Resolve encryption key
    let dataEncryptionKey: Uint8Array | null = null;
    let encryptionKey: Uint8Array;
    let encryptionVariant: 'legacy' | 'dataKey';
    const accountEncryption = this.accountCredential().encryption;
    if (opts.dataKey && accountEncryption.type !== 'dataKey') {
      throw new Error('a caller-chosen session key needs a dataKey account; a legacy account has none');
    }
    if (opts.dataKey) {
      encryptionKey = opts.dataKey.key;
      encryptionVariant = 'dataKey';
      dataEncryptionKey = opts.dataKey.wrapped;
    } else if (accountEncryption.type === 'dataKey') {

      // Generate new encryption key
      encryptionKey = getRandomBytes(32);
      encryptionVariant = 'dataKey';

      // Derive and encrypt data encryption key
      // const contentDataKey = await deriveKey(this.secret, 'Happy EnCoder', ['content']);
      // const publicKey = libsodiumPublicKeyFromSecretKey(contentDataKey);
      dataEncryptionKey = wrapDataEncryptionKey(encryptionKey, accountEncryption.publicKey);
    } else {
      encryptionKey = accountEncryption.secret;
      encryptionVariant = 'legacy';
    }

    // Create session
    try {
      const response = await axios.post<CreateSessionResponse>(
        `${configuration.serverUrl}/v1/sessions`,
        {
          tag: opts.tag,
          metadata: encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.metadata)),
          agentState: opts.state ? encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.state)) : null,
          dataEncryptionKey: dataEncryptionKey ? encodeBase64(dataEncryptionKey) : null,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.bearer()}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`
          },
          timeout: 60000 // 1 minute timeout for very bad network connections
        }
      )

      logger.debug(`Session created/loaded: ${response.data.session.id} (tag: ${opts.tag})`)
      let raw = response.data.session;
      let session: Session = {
        id: raw.id,
        seq: raw.seq,
        metadata: decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.metadata)),
        metadataVersion: raw.metadataVersion,
        agentState: raw.agentState ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.agentState)) : null,
        agentStateVersion: raw.agentStateVersion,
        encryptionKey: encryptionKey,
        encryptionVariant: encryptionVariant
      }
      return session;
    } catch (error) {
      logger.debug('[API] [ERROR] Failed to get or create session:', error);

      // Classify on whether the server answered at all, before looking at any
      // error code. axios stamps a `code` on HTTP failures too — every 5xx
      // carries ERR_BAD_RESPONSE and every 4xx ERR_BAD_REQUEST — so consulting
      // codes first would let a real HTTP response be misread as a transport
      // failure.
      const errorResponse = axios.isAxiosError(error) ? error.response : undefined;
      // Only a reply-less failure is a transport failure, so classification
      // must ignore any code attached to an HTTP response — axios stamps one
      // on those too. Diagnostics should not: the message below keeps whatever
      // code there is, response or not.
      const diagnosticCode = connectionErrorCode(error);
      const transportCode = errorResponse ? undefined : diagnosticCode;

      // No reply at all — a transport failure.
      //
      // Deliberately the narrow `isNetworkError` net, not `isConnectivityError`:
      // this call mints a fresh data encryption key on every invocation, and
      // the reconnect path retries under the *same* session tag. If the server
      // in fact persisted a timed-out request, it keeps the first key and
      // ignores the resubmitted one, so treating an ambiguous failure as
      // "offline" would leave the session encrypted under a key the app does
      // not hold — silent corruption in place of a loud failure.
      if (isNetworkError(transportCode)) {
        connectionState.fail({
          operation: 'Session creation',
          caller: 'api.getOrCreateSession',
          errorCode: transportCode,
          url: `${configuration.serverUrl}/v1/sessions`
        });
        return null;
      }

      // Handle 404 gracefully - server endpoint may not be available yet
      const is404Error = (
        (axios.isAxiosError(error) && error.response?.status === 404) ||
        (error && typeof error === 'object' && 'response' in error && (error as any).response?.status === 404)
      );
      if (is404Error) {
        connectionState.fail({
          operation: 'Session creation',
          errorCode: '404',
          url: `${configuration.serverUrl}/v1/sessions`
        });
        return null;
      }

      // Handle 5xx server errors - use offline mode with auto-reconnect
      if (axios.isAxiosError(error) && error.response?.status) {
        const status = error.response.status;
        if (status >= 500) {
          connectionState.fail({
            operation: 'Session creation',
            errorCode: String(status),
            url: `${configuration.serverUrl}/v1/sessions`,
            details: ['Server encountered an error, will retry automatically']
          });
          return null;
        }
      }

      // Keep the transport code and the original error attached. Diagnosing
      // the daemon crash this guard exists for hinged on seeing the bare
      // `code: 'ECONNABORTED'` in the logs; flattening to a message string
      // throws that away.
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(
        `Failed to get or create session: ${diagnosticCode ? `${diagnosticCode} — ` : ''}${message}`,
        { cause: error }
      );
    }
  }

  /**
   * Resolve the machine encryption key and the wrap material used to register
   * it. Shared so the offline fallback keys its machine exactly the way a
   * successful registration would.
   */
  private resolveMachineEncryption(): {
    encryptionKey: Uint8Array,
    encryptionVariant: 'legacy' | 'dataKey',
    wrapMaterial: { machineKey: Uint8Array, accountPublicKey: Uint8Array } | null,
  } {
    const machineEncryption = this.accountCredential().encryption;
    if (machineEncryption.type === 'dataKey') {
      return {
        encryptionKey: machineEncryption.machineKey,
        encryptionVariant: 'dataKey',
        wrapMaterial: {
          machineKey: machineEncryption.machineKey,
          accountPublicKey: machineEncryption.publicKey,
        },
      };
    }
    // Legacy encryption.
    // aplus §6-1 Phase 3b — legacy 활성이어도 병기된 provisioned 재료가
    // 있으면 wrap 된 machineKey 를 서버에 등록한다 (서버는 write-once
    // 백필). RPC 암호화는 여전히 legacy secret — 동작 무변경.
    return {
      encryptionKey: machineEncryption.secret,
      encryptionVariant: 'legacy',
      wrapMaterial: machineEncryption.provisioned
        ? {
          machineKey: machineEncryption.provisioned.machineKey,
          accountPublicKey: machineEncryption.provisioned.publicKey,
        }
        : null,
    };
  }

  /**
   * Build the local-only machine used when the server cannot be reached.
   *
   * Versions start at 0; the sync client reconciles them against the server on
   * reconnect via its version-mismatch retry, so starting low is self-healing.
   * Exposed so callers that must not fail — the daemon's startup path — can
   * fall back even when getOrCreateMachine throws.
   */
  buildOfflineMachine(opts: {
    machineId: string,
    metadata: MachineMetadata,
    daemonState?: DaemonState,
  }): Machine {
    const { encryptionKey, encryptionVariant } = this.resolveMachineEncryption();
    return {
      id: opts.machineId,
      encryptionKey,
      encryptionVariant,
      metadata: opts.metadata,
      metadataVersion: 0,
      daemonState: opts.daemonState || null,
      daemonStateVersion: 0,
    };
  }

  /**
   * Register or update machine with the server
   * Returns the current machine state from the server with decrypted metadata and daemonState
   */
  async getOrCreateMachine(opts: {
    machineId: string,
    metadata: MachineMetadata,
    daemonState?: DaemonState,
    /** aplus §6-1 B1 — 서버 서비스 공개키(base64). 있으면 machineKey 를
     *  서버 몫으로도 wrap 해 serverDataEncryptionKey 로 등록한다. */
    serverPublicKey?: string | null,
  }): Promise<Machine> {
    if (this.principal.kind === 'managed-session') {
      // A managed child has no machine identity of its own; the runtime it
      // runs inside is the registered thing, and its scoped bearer could not
      // register one anyway.
      throw new Error('a managed session does not register a machine');
    }
    if (this.principal.kind === 'managed-machine') {
      // The parent registered this Machine, with key material the server keeps
      // write-once. Registering again would at best be a no-op and at worst
      // replace what the parent stored — and then nothing can read the machine.
      throw new Error('a managed runtime does not register its own machine');
    }

    const { encryptionKey, encryptionVariant, wrapMaterial } = this.resolveMachineEncryption();
    // aplus §6-1 B1 — 서버 서비스 공개키가 알려져 있으면 machineKey 를 서버
    // 몫으로도 wrap 한다 (이중 수신자). 세션 키는 여기 관여하지 않는다.
    const serverPublicKey = opts.serverPublicKey
      ? decodeBase64(opts.serverPublicKey)
      : null;
    const { dataEncryptionKey, serverDataEncryptionKey } =
      buildMachineKeyEnvelopes(wrapMaterial, serverPublicKey);

    // Helper to create minimal machine object for offline mode (DRY)
    const createMinimalMachine = (): Machine => this.buildOfflineMachine(opts);

    // Create machine
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/machines`,
        {
          id: opts.machineId,
          metadata: encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.metadata)),
          daemonState: opts.daemonState ? encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.daemonState)) : undefined,
          dataEncryptionKey: dataEncryptionKey ? encodeBase64(dataEncryptionKey) : undefined,
          serverDataEncryptionKey: serverDataEncryptionKey ? encodeBase64(serverDataEncryptionKey) : undefined
        },
        {
          headers: {
            'Authorization': `Bearer ${this.bearer()}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`
          },
          timeout: 60000 // 1 minute timeout for very bad network connections
        }
      );


      const raw = response.data.machine;
      logger.debug(`[API] Machine ${opts.machineId} registered/updated with server`);
      const serverDaemonState = raw.daemonState
        ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.daemonState))
        : null;

      // Return decrypted machine like we do for sessions
      const machine: Machine = {
        id: raw.id,
        encryptionKey: encryptionKey,
        encryptionVariant: encryptionVariant,
        metadata: raw.metadata ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.metadata)) : null,
        metadataVersion: raw.metadataVersion || 0,
        // Existing machines return the previously persisted state. Keep its
        // forward-compatible fields, but seed this process's startup state so
        // ApiMachine.connect() publishes the new ephemeral capabilities.
        daemonState: opts.daemonState
          ? { ...serverDaemonState, ...opts.daemonState }
          : serverDaemonState,
        daemonStateVersion: raw.daemonStateVersion || 0,
      };
      return machine;
    } catch (error) {
      // Classify on whether the server answered at all, before looking at any
      // error code. axios stamps a `code` on HTTP failures too — every 5xx
      // carries ERR_BAD_RESPONSE and every 4xx ERR_BAD_REQUEST — so consulting
      // codes first would swallow real HTTP responses as transport failures and
      // leave the status branches below unreachable.
      const errorResponse = axios.isAxiosError(error) ? error.response : undefined;

      // The server answered. It is reachable, so this is not offline mode.
      if (errorResponse?.status) {
        const status = errorResponse.status;

        if (status === 403 || status === 409) {
          // Re-auth conflict: machine registered to old account, re-association not allowed
          console.log(chalk.yellow(
            `⚠️  Machine registration rejected by the server with status ${status}`
          ));
          console.log(chalk.yellow(
            `   → This machine ID is already registered to another account on the server`
          ));
          console.log(chalk.yellow(
            `   → This usually happens after re-authenticating with a different account`
          ));
          console.log(chalk.yellow(
            `   → Run 'happy doctor clean' to reset local state and generate a new machine ID`
          ));
          console.log(chalk.yellow(
            `   → Open a GitHub issue if this problem persists`
          ));
          return createMinimalMachine();
        }

        // Handle 5xx - server error, use offline mode with auto-reconnect
        if (status >= 500) {
          connectionState.fail({
            operation: 'Machine registration',
            errorCode: String(status),
            url: `${configuration.serverUrl}/v1/machines`,
            details: ['Server encountered an error, will retry automatically']
          });
          return createMinimalMachine();
        }

        // Handle 404 - endpoint may not be available yet
        if (status === 404) {
          connectionState.fail({
            operation: 'Machine registration',
            errorCode: '404',
            url: `${configuration.serverUrl}/v1/machines`
          });
          return createMinimalMachine();
        }

        // Handle 401 - the token expired or was rotated. Recoverable by the
        // user, so say what to do rather than dying with an opaque stack.
        // Logged as well as printed: the daemon is spawned with stdio 'ignore',
        // so on the path this matters most console output goes nowhere.
        if (status === 401) {
          logger.debug('[API] Machine registration rejected with 401 — credentials are no longer valid, run `happy auth`');
          console.log(chalk.yellow(
            `⚠️  Machine registration rejected by the server with status 401`
          ));
          console.log(chalk.yellow(
            `   → Your credentials are no longer valid — run 'happy auth' to sign in again`
          ));
          return createMinimalMachine();
        }

        // Rate limiting is transient by definition, and the reconnect loop is
        // the right thing to wait on.
        if (status === 429) {
          connectionState.fail({
            operation: 'Machine registration',
            errorCode: '429',
            url: `${configuration.serverUrl}/v1/machines`,
            details: ['Will retry automatically']
          });
          return createMinimalMachine();
        }

        // Any other 4xx the server managed to return — 400 and 422 from a
        // request this client built wrong, 426 for a client too old, and so on.
        // These are permanent: retrying identical bytes will fail identically,
        // and registration is attempted exactly once per process. Saying
        // "server unreachable, will retry" would be false twice over, so report
        // it as the contract problem it is. Still return a local machine rather
        // than throwing — the daemon staying up is the point of this path.
        if (status >= 400) {
          logger.debug(`[API] Machine registration rejected with ${status}`, errorResponse.data);
          console.log(chalk.yellow(
            `⚠️  The server rejected machine registration with status ${status}`
          ));
          console.log(chalk.yellow(
            `   → Continuing with local-only state; this machine will not sync`
          ));
          console.log(chalk.yellow(
            `   → This is a client/server mismatch rather than a network problem — please report it`
          ));
          return createMinimalMachine();
        }

        // A non-4xx status that still rejected: axios raises ERR_BAD_RESPONSE
        // with `response` set and a 2xx status when the body will not parse —
        // a captive portal or proxy answering 200 with HTML. Calling that a
        // rejection would be false, and a body we cannot read means we cannot
        // trust anything about the registration, so fail instead of pretending
        // to be offline. The daemon guard keeps the daemon up; the agent CLIs
        // print this message, so say something better than a parser error.
        throw new Error(
          `Machine registration returned an unreadable response (status ${status})`,
          { cause: error }
        );
      }

      // No reply at all — a transport failure.
      //
      // The wide `isConnectivityError` net, unlike the session path above:
      // `POST /v1/machines` is an idempotent upsert keyed on a machine id, and
      // the machine key is derived from credentials rather than generated per
      // call, so replaying a request the server already applied is harmless.
      // Registration is also on the daemon's startup path, where an unhandled
      // error is a FATAL exit — being generous here is what keeps the daemon
      // alive through a network blip.
      const errorCode = connectionErrorCode(error);
      if (isConnectivityError(errorCode)) {
        connectionState.fail({
          operation: 'Machine registration',
          caller: 'api.getOrCreateMachine',
          errorCode,
          url: `${configuration.serverUrl}/v1/machines`
        });
        return createMinimalMachine();
      }

      // Anything left is not a transport failure and not an HTTP response —
      // a genuine defect (bad encryption input, a programming error). Those
      // must stay loud rather than be masked as "offline".
      throw error;
    }
  }

  sessionSyncClient(session: Session, options: { trackShutdownStorage?: boolean } = {}): ApiSessionClient {
    if (this.principal.kind === 'managed-session') {
      if (options.trackShutdownStorage) throw new Error('Standalone storage tracking is not a managed runtime capability');
      applySessionUrlEnv(process.env, session.id, configuration.webappUrl);
      // The explicit mode, never inferred: it decides whether redirects are
      // followed and which origin may see this bearer.
      return new ApiSessionClient(
        this.principal.attachment.scopedToken, session, this.principal.attachment.managed,
      );
    }
    // The session id is confirmed exactly here for every flavor (claude, codex,
    // gemini, openclaw, acp — online, reconnect-in-place, and offline→reconnect
    // all funnel through this factory before the agent loop starts), so export
    // the session's own web URL for agent shell subprocesses to inherit
    // (specs/desktop-issue-pr-session-link R2). The confirmed current id wins
    // over stale values inherited from a parent or an earlier resume process.
    applySessionUrlEnv(process.env, session.id, configuration.webappUrl);
    return new ApiSessionClient(this.bearer(), session, undefined, options);
  }

  machineSyncClient(machine: Machine): ApiMachineClient {
    return new ApiMachineClient(this.bearer(), machine);
  }

  /**
   * Post a session event to the durable event log on the server.
   * Used by daemon recovery to emit session-end for dead sessions.
   */
  async postSessionEvent(sessionId: string, eventType: string, content: string): Promise<void> {
    try {
      await axios.post(
        `${configuration.serverUrl}/v3/sessions/${sessionId}/events`,
        { eventType, content },
        {
          headers: {
            'Authorization': `Bearer ${this.bearer()}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      logger.debug(`[API] Session event posted: ${eventType} for session ${sessionId}`);
    } catch (error) {
      logger.debug(`[API] Failed to post session event: ${error}`);
    }
  }

  push(): PushNotificationClient {
    if (!this.pushClient) {
      // There is no account here to notify, and the scoped bearer could not
      // read an account's push tokens even if there were.
      throw new Error('a managed session has no push notification client');
    }
    return this.pushClient;
  }

  /**
   * Register a vendor API token with the server
   * The token is sent as a JSON string - server handles encryption
   */
  async registerVendorToken(vendor: 'openai' | 'anthropic' | 'gemini', apiKey: any): Promise<void> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/connect/${vendor}/register`,
        {
          token: JSON.stringify(apiKey)
        },
        {
          headers: {
            'Authorization': `Bearer ${this.bearer()}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`
          },
          timeout: 5000
        }
      );

      if (response.status !== 200 && response.status !== 201) {
        throw new Error(`Server returned status ${response.status}`);
      }

      logger.debug(`[API] Vendor token for ${vendor} registered successfully`);
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to register vendor token:`, error);
      throw new Error(`Failed to register vendor token: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get vendor API token from the server
   * Returns the token if it exists, null otherwise
   */
  async getVendorToken(vendor: 'openai' | 'anthropic' | 'gemini'): Promise<any | null> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/connect/${vendor}/token`,
        {
          headers: {
            'Authorization': `Bearer ${this.bearer()}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`
          },
          timeout: 5000
        }
      );

      if (response.status === 404) {
        logger.debug(`[API] No vendor token found for ${vendor}`);
        return null;
      }

      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }

      // Log raw response for debugging
      logger.debug(`[API] Raw vendor token response:`, {
        status: response.status,
        dataKeys: Object.keys(response.data || {}),
        hasToken: 'token' in (response.data || {}),
        tokenType: typeof response.data?.token,
      });

      // Token is returned as JSON string, parse it
      let tokenData: any = null;
      if (response.data?.token) {
        if (typeof response.data.token === 'string') {
          try {
            tokenData = JSON.parse(response.data.token);
          } catch (parseError) {
            logger.debug(`[API] Failed to parse token as JSON, using as string:`, parseError);
            tokenData = response.data.token;
          }
        } else if (response.data.token !== null) {
          // Token exists and is not null
          tokenData = response.data.token;
        } else {
          // Token is explicitly null - treat as not found
          logger.debug(`[API] Token is null for ${vendor}, treating as not found`);
          return null;
        }
      } else if (response.data && typeof response.data === 'object') {
        // Maybe the token is directly in response.data
        // But check if it's { token: null } - treat as not found
        if (response.data.token === null && Object.keys(response.data).length === 1) {
          logger.debug(`[API] Response contains only null token for ${vendor}, treating as not found`);
          return null;
        }
        tokenData = response.data;
      }
      
      // Final check: if tokenData is null or { token: null }, return null
      if (tokenData === null || (tokenData && typeof tokenData === 'object' && tokenData.token === null && Object.keys(tokenData).length === 1)) {
        logger.debug(`[API] Token data is null for ${vendor}`);
        return null;
      }
      
      logger.debug(`[API] Vendor token for ${vendor} retrieved successfully`, {
        tokenDataType: typeof tokenData,
        tokenDataKeys: tokenData && typeof tokenData === 'object' ? Object.keys(tokenData) : 'not an object',
      });
      return tokenData;
    } catch (error: any) {
      if (error.response?.status === 404) {
        logger.debug(`[API] No vendor token found for ${vendor}`);
        return null;
      }
      logger.debug(`[API] [ERROR] Failed to get vendor token:`, error);
      return null;
    }
  }

  /**
   * Mark a session as inactive on the server (active=false). Does NOT
   * change `lifecycleState`, so the session remains visible in the app
   * and resumable — same effect as the in-app "Archive" button hitting
   * the /archive endpoint, but without the extra metadata.
   *
   * Used during graceful shutdown (Ctrl-C / SIGTERM) as a synchronous
   * fallback for the socket-based session-end signal: even if the
   * socket emit doesn't drain before the process exits, the HTTP
   * response confirms the deactivate landed.
   */
  async deactivateSession(sessionId: string): Promise<boolean> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/sessions/${sessionId}/archive`,
        {},
        {
          headers: {
            'Authorization': `Bearer ${this.bearer()}`,
            'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`,
          },
          timeout: 3000,
        },
      );
      return response.status >= 200 && response.status < 300;
    } catch (error) {
      logger.debug('[API] deactivateSession failed:', error);
      return false;
    }
  }
}
