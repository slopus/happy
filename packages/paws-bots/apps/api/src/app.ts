import { AsyncLocalStorage } from "node:async_hooks";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type {
  AgentContextStrategy,
  AgentRuntime,
  BillingProvider,
  ConnectorProvider,
  JobPublisher,
  ManagedConnectorProvider,
  MessagingSurface,
  NotificationProvider,
  RealtimeFanout,
  SandboxProvider,
  TransactionalEmailProvider,
} from "@rakazo/adapter-kit";
import { EmailRecipientRejectedError } from "@rakazo/adapter-kit";
import type {
  ComposioProvider,
  ConnectorRegistry,
  createRunExecutor,
  PluginRepoFetcher,
  PluginTextReader,
  RemoteConnectorDependencies,
  RunRuntimeEnv,
  UserDeviceGateway,
} from "@rakazo/adapters";
import {
  BillingEmulator,
  ChatSdkMessagingSurface,
  CodexCatalogCache,
  configuredBotEmailProvider,
  contentKeyProviderFromEnv,
  createAgentHomeStore,
  createApnsActivityProvider,
  createApnsVoipProvider,
  createArtifactStore,
  createCloudAgentConnection,
  createConnectorRuntime,
  createMediaGenerationProvider,
  createPaymentWalletProvider,
  createProductAnalytics,
  createRunReconciler,
  createRunRuntime,
  createRunSandbox,
  createRunSecretWriter,
  createSecretStore,
  createTicketChangeNotifier,
  EmailEmulator,
  ExpoPushProvider,
  GraphileJobPublisher,
  InMemoryJobQueue,
  InMemoryRealtimeFanout,
  installedMessaging,
  isMessagingSurfaceEnabled,
  messagingPlatformsFromEnv,
  ObjectAgentHomeStore,
  PiAgentRuntime,
  PiOAuthLogins,
  PostgresRealtimeFanout,
  PrismaPushTokenStore,
  piSessionsRoot,
  RunJobPublisher,
  RunStarter,
  removePiUserSessions,
  resolveDeploymentModel,
  ScriptedAgentRuntime,
  SpaceMemoryProviderResolver,
  StripeBillingProvider,
  sandboxProviderOptionsFromEnv,
  stripeBillingConfigFromEnv,
  UserDeviceHub,
  UserDevices,
  userDeviceForwardSecret,
  userDeviceInternalAddress,
  verifyModelServesAgents,
  WorkActivities,
  withHostComputerScreen,
  withSecretPersistence,
} from "@rakazo/adapters";
import type { DirectoryAccountChange } from "@rakazo/auth";
import {
  buildTrustedOrigins,
  CLIENT_IP_HEADER,
  createAuth,
  createDirectory,
  isBlockedAuthPath,
  publicSignInProviders,
} from "@rakazo/auth";
import type { Actor, AuthCapabilities, ModelCredential } from "@rakazo/contracts";
import {
  isLocalhostOrLoopbackIp,
  PLUGIN_SUBMISSIONS_PATH,
  SERVER_BUILD_HEADER,
} from "@rakazo/contracts";
import { encryptionKeyWarning, signupPolicyFromEnv } from "@rakazo/core";
import type { Pool, PrismaClient } from "@rakazo/db";
import {
  configureProviderTransactionPool,
  createBoardEvents,
  createDb,
  createPool,
  createThreadEvents,
  databaseOutage,
  describeRowSecurity,
  IsolationError,
  installAuditEventStore,
  installSecurityEventStore,
  observeThreadChanges,
  parsePositiveInteger,
  pushSessionExpiresAt,
  requireMembership,
  rowSecurityWarning,
  runAsSystem,
  verifyContentKeys,
} from "@rakazo/db";
import type { Logger } from "@rakazo/logging";
import {
  createServiceLogger,
  enrichLogContext,
  getLogger,
  installLogger,
  SERVICE_NAMES,
} from "@rakazo/logging";
import { requestLogging } from "@rakazo/logging/hono";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { deleteAccountContent, finishStalledOrganizationDeletions } from "./account-deletion.js";
import { mountAccountExportRoute } from "./account-export.js";
import { mountAccountImportRoute } from "./account-import.js";
import { settleDirectoryChange } from "./account-status.js";
import { mountAppAssociation, nativePasskeys } from "./app-association.js";
import { storeInboundAttachment } from "./artifacts.js";
import { mountAuditExportRoute } from "./audit-export.js";
import { createBillingService } from "./billing.js";
import { mountBillingRoutes } from "./billing-webhook.js";
import { clientBuildMiddleware, readDeployedWebBuild } from "./client-build.js";
import {
  clientIpMiddleware,
  createClientIpResolver,
  defaultTrustedProxies,
  requestClientIp,
  withClientIp,
} from "./client-ip.js";
import { cspReportRoutes } from "./csp-report.js";
import { configuredEmailProvider } from "./email.js";
import { mountEmailInboundRoute } from "./email-inbound.js";
import type { AppEnv } from "./env.js";
import { loadEnv } from "./env.js";
import { createExperiments } from "./experiments.js";
import { healthRoutes } from "./health.js";
import { homeRetentionSweep } from "./home-retention.js";
import { startHourlySweep } from "./hourly-sweep.js";
import { trackInFlightRequests } from "./in-flight-requests.js";
import { mountLocalComputerHost } from "./local-settings.js";
import { marketingEmailRoutes, sendWelcomeEmail } from "./marketing-email.js";
import { moveMcpArgsIntoSecrets } from "./mcp-args-migration.js";
import { startMessagingRuntime } from "./messaging-runtime.js";
import { monitoringRoutes } from "./monitoring.js";
import { pluginSubmissionRoutes } from "./plugin-submissions.js";
import { sendReferralEmails } from "./referral-email.js";
import { mountApiRequestBodyLimits, rpcBodyLimit } from "./request-body-limit.js";
import { createRouter } from "./router.js";
import {
  DATABASE_RETRY_AFTER_SECONDS,
  failedOnDatabaseOutage,
  handleHttpError,
  handleRpcError,
  requestHitDatabaseOutage,
} from "./rpc-errors.js";
import { mountScreenTarget } from "./screen-proxy.js";
import { mountScriptAssets } from "./script-assets.js";
import { createAuthResponseAudit } from "./security-audit.js";
import { mountSharedPages } from "./shared-pages.js";
import { afterSpaceDeparture } from "./space-departure.js";
import { createSpeechSummarizer } from "./speech-summary.js";
import { settleWithTimeout } from "./team-chat-startup.js";
import { endUserDeviceSession, mountUserDeviceRoutes } from "./user-devices.js";
import { mountVoiceHttpRoutes } from "./voice.js";
import { mountWebhookHttpRoutes } from "./webhook.js";

/**
 * Native clients always send the app scheme, including in Expo Go, so no
 * exp:// origin is trusted: it would accept any Expo host as a redirect target.
 * The loopback entries are the Expo web dev server.
 */
export const MOBILE_AUTH_ORIGINS = [
  "rakazo://",
  "http://localhost:8081",
  "http://127.0.0.1:8081",
  "http://localhost:19006",
  "http://127.0.0.1:19006",
];

// Deploys give the old API 30 seconds to stop before killing it.
const REQUEST_DRAIN_MS = 20_000;

export interface AppHandles {
  app: Hono;
  prisma: PrismaClient;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
  composio?: ComposioProvider;
  connectors: ConnectorRegistry;
  messaging?: MessagingSurface;
  email?: TransactionalEmailProvider;
  notifications: NotificationProvider;
  executor: ReturnType<typeof createRunExecutor>;
  runtime: AgentRuntime;
  awaitIdle?: () => Promise<void>;
  backgroundFailures?: () => Array<{ name: string; count: number }>;
  /** Node `upgrade` listener for desktop device sockets; absent when the feature is off. */
  handleUpgrade?: UserDeviceHub["handleUpgrade"];
  stop: () => Promise<void>;
}

// Startup and everything it schedules (pollers, team chat, the in-memory job
// queue, retries) runs across tenants. Requests start without a context and get
// one per route: tenant for signed-in procedures, system for auth and webhooks.
export function createApp(overrides: CreateAppOverrides = {}): Promise<AppHandles> {
  return runAsSystem("api startup and background work", () => buildApp(overrides));
}

type CreateAppOverrides = Partial<AppEnv> & {
  prisma?: PrismaClient;
  realtime?: RealtimeFanout;
  sandbox?: SandboxProvider;
  composio?: ComposioProvider;
  /** Test-only connector providers registered beside the configured ones. */
  connectors?: ConnectorProvider[];
  pipedream?: ManagedConnectorProvider;
  messaging?: MessagingSurface;
  email?: TransactionalEmailProvider;
  notifications?: NotificationProvider;
  billing?: BillingProvider;
  remoteConnectors?: RemoteConnectorDependencies;
  pluginRepoFetcher?: PluginRepoFetcher;
  pluginMarketplaceRead?: PluginTextReader;
  modelConnectionFetch?: typeof fetch;
  logger?: Logger;
  runtime?: AgentRuntime;
  contextStrategy?: AgentContextStrategy;
  /** Test-only stand-in for desktops connected to this server. */
  userDevices?: UserDeviceGateway;
  /** Test-only present moment the agent is told. */
  now?: () => Date;
};

async function buildApp(overrides: CreateAppOverrides): Promise<AppHandles> {
  const {
    prisma: prismaOverride,
    realtime: realtimeOverride,
    sandbox: sandboxOverride,
    composio: composioOverride,
    connectors: connectorOverrides = [],
    pipedream: pipedreamOverride,
    messaging: messagingOverride,
    email: emailOverride,
    notifications: notificationsOverride,
    billing: billingOverride,
    remoteConnectors,
    modelConnectionFetch,
    pluginRepoFetcher,
    pluginMarketplaceRead,
    logger: loggerOverride,
    runtime: runtimeOverride,
    contextStrategy,
    userDevices: userDevicesOverride,
    now,
    ...envOverrides
  } = overrides;
  const env = { ...loadEnv(process.env), ...envOverrides };
  const runtimeEnv: RunRuntimeEnv = { ...env, inboundEmailDomain: env.inboundEmail?.domain };
  const logger = loggerOverride ?? createServiceLogger({ service: SERVICE_NAMES.api });
  installLogger(logger);
  const poolMax = parsePositiveInteger(process.env.DB_POOL_MAX, 4);
  configureProviderTransactionPool(poolMax);
  const created = prismaOverride
    ? { prisma: prismaOverride, pool: undefined }
    : createDb(env.databaseUrl, {
        poolMax,
        applicationName: "rakazo-api",
        keyProvider: contentKeyProviderFromEnv(),
        encryptContent: env.contentEncryption,
      });
  let { prisma } = created;
  // Built before anything listens, so a bad TRUSTED_PROXIES entry stops startup.
  const clientIp = createClientIpResolver({
    // Unset trusts the proxies a stack is built with: on loopback or on the API's own networks.
    // Trusting none would make the web proxy every client, one sign-in rate-limit bucket for all.
    trustedProxies: env.trustedProxies.length > 0 ? env.trustedProxies : defaultTrustedProxies(),
    header: env.clientIpHeader,
  });
  const rowSecurity = rowSecurityWarning(await describeRowSecurity(prisma));
  if (rowSecurity) logger.warn(rowSecurity);
  const weakEncryptionKey = encryptionKeyWarning(process.env);
  if (weakEncryptionKey) logger.warn(weakEncryptionKey);
  // Set once push delivery is configured below; thread changes before then have no cards.
  let workActivities: WorkActivities | undefined;
  // Every thread change this process commits also updates its users' live status cards.
  const realtime = observeThreadChanges(
    realtimeOverride ??
      (created.pool
        ? new PostgresRealtimeFanout({
            connectionString: env.realtimeDatabaseUrl,
            publisher: created.pool,
          })
        : new InMemoryRealtimeFanout()),
    (threadId) => workActivities?.threadChanged(threadId),
  );
  const secrets = createSecretStore(env.encryptionKey, process.env, realtime);
  await secrets.start();
  if (secrets.describe().capabilities.degraded)
    logger.warn("Secret storage degraded; encrypted credentials remain available");
  prisma = withSecretPersistence(prisma, secrets);
  installSecurityEventStore(prisma);
  installAuditEventStore(prisma);
  const unreadableMasterKeys = await verifyContentKeys(prisma);
  if (unreadableMasterKeys.length)
    logger.error("Stored space keys need master keys that are not configured", undefined, {
      masterKeyIds: unreadableMasterKeys,
    });
  const analytics = createProductAnalytics();
  const events = createThreadEvents(prisma, realtime, {
    analytics,
    runSecretWriter: createRunSecretWriter(secrets),
  });
  const ticketBoardEnabled = env.ticketBoardEnabled;
  const boardEvents = createBoardEvents(realtime);
  const environmentSignupPolicy = signupPolicyFromEnv(env);
  // Mirror the env policy for the previous release during a rolling deploy.
  await prisma.deploymentSettings.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      signupsEnabled: environmentSignupPolicy.enabled,
      signupAllowlist: environmentSignupPolicy.allowlist.join(","),
      signupPolicyInitialized: true,
    },
    update: {
      signupsEnabled: environmentSignupPolicy.enabled,
      signupAllowlist: environmentSignupPolicy.allowlist.join(","),
      signupPolicyInitialized: true,
    },
  });

  const jobKind = env.wakeupDriver;
  const inMemoryJobs = jobKind === "memory" ? new InMemoryJobQueue() : undefined;
  // prismaOverride skips createDb, so there is no shared pool; keep a bounded one for jobs.
  let ownedJobPool: Pool | undefined;
  if (!inMemoryJobs && !created.pool) {
    ownedJobPool = createPool(env.databaseUrl, {
      poolMax: parsePositiveInteger(process.env.DB_POOL_MAX, 4),
      applicationName: "rakazo-api-jobs",
    });
  }
  const jobPool = created.pool ?? ownedJobPool;
  const shutdown = new AbortController();
  // Chat starts in the process that receives it; the worker only takes what this one can't.
  const runs = inMemoryJobs ? undefined : new RunStarter(realtime, { signal: shutdown.signal });
  const jobs =
    inMemoryJobs ??
    new RunJobPublisher(
      prisma,
      new GraphileJobPublisher(
        jobPool ??
          (() => {
            throw new Error("Graphile job publisher requires a PostgreSQL pool");
          })(),
        prisma,
      ),
      runs!,
    );
  const ticketChanges = createTicketChangeNotifier({
    boardEvents,
    jobs,
    prisma,
    ticketBoardEnabled,
  });
  const hostComputer = sandboxProviderOptionsFromEnv();
  const sandbox: SandboxProvider =
    sandboxOverride ??
    (await createRunSandbox(env.sandboxProvider, {
      ...hostComputer,
      supervisorUrl: env.sandboxSupervisorUrl,
      supervisorToken: env.sandboxSupervisorToken,
      e2bApiKey: env.e2bApiKey,
      novitaApiKey: env.novitaApiKey,
      sandboxTemplate: env.sandboxTemplate,
      daytonaApiKey: env.daytonaApiKey,
      daytonaApiUrl: env.daytonaApiUrl,
      daytonaTarget: env.daytonaTarget,
      boatApiKey: env.boatApiKey,
      boatApiUrl: env.boatApiUrl,
      dataDir: env.dataDir,
      prisma,
      secrets,
    }));
  const memoryProviders = new SpaceMemoryProviderResolver(prisma, secrets);
  const oauthLogins = new PiOAuthLogins<ModelCredential>(undefined, { prisma, secrets });
  const home = createAgentHomeStore(env.dataDir, prisma);
  void home.removeStaleStaging().catch((error) => getLogger().error("home staging cleanup", error));
  const artifacts = createArtifactStore(env.dataDir, prisma);
  const memory = new MarkdownMemoryStore(prisma);
  // This process registers the inbound sink, so it must hold Telegram's getUpdates connection.
  const messagingPlatforms = messagingPlatformsFromEnv(env, { pollInboundMessages: true }).filter(
    (platform) => platform.provider !== "slack" || !env.slackClientId,
  );
  const legacyMessaging =
    messagingOverride ??
    (isMessagingSurfaceEnabled(messagingPlatforms, {
      deploymentModelConfigured: env.deploymentModelConfigured,
      openSignup: env.messagingOpenSignup,
    })
      ? new ChatSdkMessagingSurface(messagingPlatforms)
      : undefined);
  const { messaging, installations: messagingInstallations } = messagingOverride
    ? { messaging: messagingOverride, installations: undefined }
    : installedMessaging(prisma, secrets, env, legacyMessaging, jobs);
  const configuredEmail = emailOverride ?? configuredEmailProvider(env);
  const localEmailEmulator =
    !configuredEmail && env.emailEmulator
      ? new EmailEmulator((message) => {
          getLogger().info("email emulator captured message", {
            "email.subject": message.subject,
          });
        })
      : undefined;
  if (localEmailEmulator && !isLocalhostOrLoopbackIp(env.apiHost)) {
    throw new Error("EMAIL_EMULATOR requires API_HOST to be a loopback host");
  }
  const email: TransactionalEmailProvider | undefined = configuredEmail ?? localEmailEmulator;
  const botEmail: TransactionalEmailProvider | undefined =
    configuredBotEmailProvider({
      smtpUrl: env.botEmailSmtpUrl,
      domain: env.inboundEmail?.domain,
    }) ?? localEmailEmulator;
  const emailErrorLogger = (message: string) => (error: unknown) => {
    if (error instanceof EmailRecipientRejectedError) {
      getLogger().warn(message, { "error.message": error.message });
    } else getLogger().error(message, error);
  };
  const onEmailError = emailErrorLogger("transactional email delivery failed");
  const stripeBilling = stripeBillingConfigFromEnv(env);
  const localBillingEmulator =
    !billingOverride && !stripeBilling && env.billingEmulator
      ? new BillingEmulator({ modelCredits: true })
      : undefined;
  if (localBillingEmulator && !isLocalhostOrLoopbackIp(env.apiHost)) {
    throw new Error("BILLING_EMULATOR requires API_HOST to be a loopback host");
  }
  const billingProvider: BillingProvider | undefined =
    billingOverride ??
    (stripeBilling ? new StripeBillingProvider(stripeBilling) : localBillingEmulator);
  const billing = billingProvider
    ? createBillingService({
        prisma,
        provider: billingProvider,
        sandbox,
        webOrigin: env.webOrigin,
        managedModelsAvailable: resolveDeploymentModel().configured,
        analytics,
        experiments: createExperiments(env.experiments),
      })
    : undefined;
  const modelCreditsEnabled = billing?.modelCreditsEnabled ?? false;
  await prisma.deploymentSettings.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      modelCreditsEnabled,
    },
    update: { modelCreditsEnabled },
  });
  const connectors = createConnectorRuntime(
    runtimeEnv,
    { prisma, secrets, events },
    {
      network: remoteConnectors,
      composio: composioOverride,
      pipedream: pipedreamOverride,
      connectors: connectorOverrides,
    },
  );
  const { mcpOAuth, mcp, pipedream, installed, integrationSettings, stack, userCloudAgents } =
    connectors;
  const baseRuntime =
    runtimeOverride ??
    (env.agentRuntime === "scripted"
      ? new ScriptedAgentRuntime()
      : new PiAgentRuntime({
          sessionRoot: env.piSessionRecording ? piSessionsRoot(env.dataDir) : undefined,
        }));
  const pushTokens = new PrismaPushTokenStore(prisma, env.encryptionKey);
  const notifications =
    notificationsOverride ??
    new ExpoPushProvider(pushTokens, {
      sessionExpiresAt: (sessionId) => pushSessionExpiresAt(prisma, sessionId),
      jobs,
      accessToken: env.expoAccessToken,
      voip: await createApnsVoipProvider(env.apnsVoip),
    });
  const activityPush = await createApnsActivityProvider(env.apnsVoip);
  if (activityPush) workActivities = new WorkActivities(prisma, env.encryptionKey, activityPush);
  const userDeviceSecret = userDeviceForwardSecret(env.encryptionKey);
  const userDeviceHub = env.userDevicesEnabled
    ? new UserDeviceHub({ prisma, address: userDeviceInternalAddress(env.apiHost, env.port) })
    : undefined;
  const userDevices = userDeviceHub
    ? new UserDevices({ prisma, forwardSecret: userDeviceSecret, hub: userDeviceHub })
    : undefined;
  const deviceSessions = {
    prisma,
    devices: userDevices ?? new UserDevices({ prisma, forwardSecret: userDeviceSecret }),
  };
  // A SCIM request records the accounts it turned off or on; the route settles them after commit.
  const directoryChanges = new AsyncLocalStorage<DirectoryAccountChange[]>();
  const directory = env.scimBearerToken
    ? await createDirectory(prisma, {
        token: env.scimBearerToken,
        secret: env.authSecret,
        baseURL: env.authUrl,
        ipAddressHeader: CLIENT_IP_HEADER,
        logger: authLibraryLogger("directory.request.failed"),
        onAccountChange: (change) => directoryChanges.getStore()?.push(change),
      })
    : undefined;
  const auth = createAuth(prisma, {
    directoryProvisioning: Boolean(directory),
    analytics,
    passwordAuth: env.passwordAuth,
    breachedPasswordCheck: env.breachedPasswordCheck,
    oidc: env.oidc,
    social: env.social,
    secret: env.authSecret,
    baseURL: env.authUrl,
    webOrigin: env.webOrigin,
    signupsEnabled: env.signupsEnabled,
    signupAllowlist: env.signupAllowlist,
    singleAccount: Boolean(env.desktopStackToken),
    email,
    logger: authLibraryLogger("auth.request.failed"),
    onEmailError,
    afterSignIn:
      email && env.welcomeEmailEnabled
        ? (userId, headers) =>
            sendWelcomeEmail(
              {
                prisma,
                email,
                origin: env.authUrl,
                secret: env.authSecret,
                onError: emailErrorLogger("welcome email delivery failed"),
              },
              userId,
              headers,
            )
        : undefined,
    extraOrigins: [...MOBILE_AUTH_ORIGINS, ...env.extraAuthOrigins],
    androidAppCertFingerprints: env.passkeyAndroidCertFingerprints,
    beforeDeleteUser: async (userId) => {
      // Billing cancels inside, after the account's spaces are claimed and before anything is
      // destroyed, so a provider failure aborts deletion with the account as it was.
      await deleteAccountContent(
        {
          prisma,
          sandbox,
          home,
          jobs,
          memoryProviders,
          artifacts,
          dataDir: env.dataDir,
          messagingInstallations,
          secrets,
          events,
          billing,
        },
        userId,
      );
      await removePiUserSessions(env.dataDir, userId);
      await pushTokens
        .remove(userId)
        .catch((error) => getLogger().error("push token removal failed", error));
      // Before the rows go with the account, so its phones' cards end too.
      await workActivities
        ?.endUser(userId)
        .catch((error) => getLogger().error("live status card removal failed", error));
    },
    // The session change already happened, so a registration cleanup failure must not fail sign-out.
    afterDeleteSession: async (session) => {
      await pushTokens
        .endSession(session.userId, session.id)
        .catch((error) => getLogger().error("push token removal failed", error));
      await workActivities
        ?.endSession(session.userId, session.id)
        .catch((error) => getLogger().error("live status card removal failed", error));
      await endUserDeviceSession(deviceSessions, session).catch((error) =>
        getLogger().error("user device revocation failed", error),
      );
    },
    afterReplaceSession: async (previous, session) => {
      await pushTokens
        .endSession(session.userId, previous.id, session.id)
        .catch((error) => getLogger().error("push token session update failed", error));
      await workActivities
        ?.endSession(session.userId, previous.id, session.id)
        .catch((error) => getLogger().error("live status card session update failed", error));
      await endUserDeviceSession(deviceSessions, previous, session).catch((error) =>
        getLogger().error("user device session update failed", error),
      );
    },
  });
  const oauthTokenUpgrade = auth
    .encryptStoredOAuthTokens()
    .catch((error) => getLogger().error("oauth token encryption upgrade failed", error));
  const mcpArgsMove = moveMcpArgsIntoSecrets(prisma, secrets, { signal: shutdown.signal })
    .then(({ moved }) => {
      if (moved) getLogger().info("mcp server arguments encrypted", { count: moved });
    })
    .catch((error) => {
      if (!shutdown.signal.aborted) getLogger().error("mcp server arguments move failed", error);
    });
  // One provider instance so emulator launches and polls share the same Map.
  const cloudAgent = createCloudAgentConnection({
    CLOUD_AGENT_PROVIDER: env.cloudAgentProvider,
    CURSOR_API_KEY: env.cursorApiKey,
    CLOUD_AGENT_SPACE_ID: env.cloudAgentSpaceId,
  });
  const paymentWallet = await createPaymentWalletProvider({
    PAYMENT_WALLET_PROVIDER: env.paymentWalletProvider,
    PAYMENT_WALLET_CLIENT_ID: env.paymentWalletClientId,
  });
  // One cache serves models.list, selection validation, and run-time model
  // resolution alike, so a list call warms the run path in this process.
  const codexCatalog = new CodexCatalogCache();
  // One instance: chat runs submit videos and, in single-process mode, background polls finish them.
  const mediaGeneration = createMediaGenerationProvider();
  const { runtime, executor, jobHandlers, messagingDelivery, teamChat } = createRunRuntime(
    runtimeEnv,
    connectors,
    {
      billingEnabled: modelCreditsEnabled,
      mediaGeneration,
      contextStrategy,
      prisma,
      runtime: baseRuntime,
      codexCatalog,
      sandbox,
      memory,
      memoryProviders,
      home,
      artifacts,
      secretStore: secrets,
      secretHttp: remoteConnectors,
      notifications,
      jobs,
      events,
      onTicketChange: ticketChanges,
      email: botEmail,
      messaging,
      isMessagingInstallationActive: messagingInstallations
        ? (id: string) => messagingInstallations.isActive(id)
        : undefined,
      cloudAgent,
      userDevices:
        userDevicesOverride ??
        withHostComputerScreen(userDevices, {
          prisma,
          sandboxKind: env.sandboxProvider,
          url: hostComputer.hostComputerUrl,
          token: hostComputer.hostComputerToken,
        }),
      paymentWallet,
      shutdownSignal: shutdown.signal,
      now,
    },
  );

  if (inMemoryJobs) {
    await inMemoryJobs.start(jobHandlers);
  }
  runs?.attach(jobHandlers);
  const reconciler = inMemoryJobs
    ? createRunReconciler(
        {
          prisma,
          jobs,
          events,
          notifications,
          cloudAgent,
          userCloudAgents,
          paymentWallet,
          mediaGeneration,
          billingEnabled: modelCreditsEnabled,
        },
        {},
        { messagingDelivery, teamChat },
      )
    : undefined;
  reconciler?.start();
  const stopReferralEmails =
    email && env.welcomeEmailEnabled && billing?.referralsEnabled
      ? startHourlySweep(
          sendReferralEmails({
            prisma,
            email,
            appUrl: new URL("/app", env.webOrigin).href,
            origin: env.authUrl,
            secret: env.authSecret,
            onError: onEmailError,
          }),
          onEmailError,
        )
      : undefined;

  // Self-hosted deployments without billing keep every saved home.
  const stopHomeRetention =
    email && billingProvider && home instanceof ObjectAgentHomeStore
      ? startHourlySweep(
          homeRetentionSweep({
            prisma,
            email,
            appUrl: new URL("/app", env.webOrigin).href,
            onError: (error) => getLogger().error("saved home retention failed", error),
          }),
          (error) => getLogger().error("saved home retention failed", error),
        )
      : undefined;

  const stopOrganizationDeletions = startHourlySweep(
    finishStalledOrganizationDeletions({
      prisma,
      sandbox,
      home,
      jobs,
      memoryProviders,
      artifacts,
      dataDir: env.dataDir,
      messagingInstallations,
      secrets,
      billing,
    }),
    (error) => getLogger().error("stalled organization deletion failed", error),
  );

  const router = createRouter({
    speechSummary:
      env.voiceSummaryMinChars === undefined
        ? undefined
        : {
            minChars: env.voiceSummaryMinChars,
            summarize: createSpeechSummarizer({
              prisma,
              runtime,
              resolveModel: executor.resolveModel,
            }),
          },
    analytics,
    pluginRepoFetcher,
    pluginMarketplaceRead,
    cloudAgent,
    userCloudAgents,
    paymentWallet,
    codexCatalog,
    prisma,
    notifications,
    pushTokens,
    workActivities,
    events,
    ticketChanges,
    boardEvents,
    auth,
    jobs,
    sandbox,
    memory,
    memoryProviders,
    home,
    secrets,
    oauthLogins,
    integrationSettings,
    mcpOAuth,
    mcp,
    composio: stack.composio,
    connectors: stack.connector,
    remoteConnectors,
    modelConnectionFetch,
    // The scripted runtime never calls a provider, so neither does its connect.
    modelConnectionCheck: env.agentRuntime === "pi" ? verifyModelServesAgents : undefined,
    artifacts,
    email,
    onEmailError,
    dataDir: env.dataDir,
    billing,
    messagingInstallations,
    messagingDelivery,
    messaging: {
      enabled: Boolean(messaging),
      providers: messaging?.platforms().map((platform) => platform.provider) ?? [],
      addresses: Object.fromEntries(
        (messaging?.platforms() ?? []).flatMap((platform) =>
          platform.address ? [[platform.provider, platform.address]] : [],
        ),
      ),
      openSignup: env.messagingOpenSignup,
    },
    env: {
      inboundEmailDomain: env.inboundEmail?.domain,
      phoneCallsEnabled: env.phoneCallsEnabled,
      phoneCallRingSeconds: env.phoneCallRingSeconds,
      ticketBoardEnabled,
      navLinks: env.navLinks,
      adminEmails: env.adminEmails,
      maxUploadSizeBytes: env.maxUploadSizeBytes,
      maxAttachmentsPerMessage: env.maxAttachmentsPerMessage,
      agentRuntime: env.agentRuntime,
      defaultProvider: env.defaultProvider,
      defaultModel: env.defaultModel,
      teamChatJudgeProvider: env.teamChatJudgeProvider,
      teamChatJudgeModel: env.teamChatJudgeModel,
      deploymentModelConfigured: env.deploymentModelConfigured,
      deploymentModelHostCredentials: env.deploymentModelHostCredentials,
      webOrigin: env.webOrigin,
      privacyPolicyUrl: env.privacyPolicyUrl,
      screenProxySecret: env.screenProxySecret,
      sandboxProvider: env.sandboxProvider,
      gitSha: env.gitSha,
      integrationsCatalogUrl: env.integrationsCatalogUrl,
      mcpAllowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
      desktopHostChoiceEnabled: Boolean(env.desktopStackToken),
      computerSettingsEnabled: env.computerSettingsEnabled,
      mcpStdioEnabled: env.mcpStdioEnabled,
      mcpStdioAllowedCommands: env.mcpStdioAllowedCommands,
    },
  });
  const rpc = new RPCHandler(router, {
    clientInterceptors: [onError((error, { path, signal }) => handleRpcError(error, path, signal))],
  });
  const app = new Hono();
  app.onError(handleHttpError);
  const inFlight = trackInFlightRequests();
  app.use("*", inFlight.middleware);
  app.use("*", requestLogging(logger));
  app.use("*", clientIpMiddleware(clientIp, env.clientIpHeader));
  app.use(
    "*",
    cors({
      origin: (origin, c) => {
        // Anyone may submit a plugin from any site; the endpoint reads no cookies.
        if (c.req.path === PLUGIN_SUBMISSIONS_PATH) return "*";
        if (!origin) return env.webOrigin;
        return isTrustedOrigin(origin, env) ? origin : "";
      },
      credentials: true,
      exposeHeaders: [SERVER_BUILD_HEADER],
    }),
  );
  // Session and account replies must never be stored by a client or an HTTP cache.
  for (const path of ["/api/auth/*", "/rpc/*"]) {
    app.use(path, async (c, next) => {
      await next();
      c.header("cache-control", "no-store");
    });
  }
  app.get("/api/auth/capabilities", (c) => {
    return c.json({
      sso: env.oidc
        ? { name: env.oidc.name, availability: auth.ssoAvailability() ?? "checking" }
        : null,
      providers: publicSignInProviders(env.social, env.oidc),
      passwordAuth: env.passwordAuth !== false,
      passwordReset: env.passwordAuth !== false && Boolean(email),
      resetUrl:
        env.passwordAuth !== false && email ? new URL("/reset-password", env.webOrigin).href : null,
      emailCode: auth.emailCodeSignIn,
      billing: Boolean(billing),
      passkeyRpId: auth.passkeyRpId,
      nativePasskeys: nativePasskeys(env, auth.passkeyRpId),
      crispWebsiteId: billing ? (env.crispWebsiteId ?? null) : null,
    } satisfies AuthCapabilities);
  });
  mountAppAssociation(app, env);
  if (localEmailEmulator && env.nodeEnv === "development") {
    app.get(
      "/api/dev/emails",
      () =>
        new Response(JSON.stringify(localEmailEmulator.sent), {
          headers: { "cache-control": "no-store", "content-type": "application/json" },
        }),
    );
  }
  app.route(
    "/",
    monitoringRoutes(
      env.browserMonitoring,
      fetch,
      async (request) => (await auth.api.getSession({ headers: request.headers }))?.user.id,
    ),
  );
  app.route("/", cspReportRoutes(requestClientIp));
  app.route(
    "/",
    pluginSubmissionRoutes({
      prisma,
      email,
      adminEmails: env.adminEmails,
      webOrigin: env.webOrigin,
      clientIp: requestClientIp,
      onEmailError,
    }),
  );
  app.route("/", marketingEmailRoutes(prisma, env.authSecret));
  mountApiRequestBodyLimits(app);
  mountScreenTarget(app, prisma, env.screenProxySecret);
  mountScriptAssets(app);
  mountSharedPages(app, prisma, requestClientIp);
  const auditAuthResponse = createAuthResponseAudit();
  // Account and session tables, signup bootstrap and account deletion span tenants;
  // webhooks authenticate a bot or provider, then resolve the tenant from it.
  for (const [path, reason] of [
    ["/api/auth/*", "authentication"],
    ["/api/v1/bots/*", "bot webhook"],
    ["/api/v1/email/*", "inbound email"],
    ["/api/v1/messaging/*", "messaging webhook"],
    ["/api/v1/phone/*", "messaging webhook"],
  ] as const) {
    app.use(path, (_c, next) => runAsSystem(reason, next));
  }
  if (directory) {
    app.on(["GET", "POST", "PUT", "PATCH", "DELETE"], "/api/auth/scim/v2/*", async (c) => {
      const changes: DirectoryAccountChange[] = [];
      const response = await directoryChanges.run(changes, () =>
        withAuthLibraryFailures(() =>
          directory.handler(withClientIp(c.req.raw, requestClientIp(c))),
        ),
      );
      // A retried write reports an account again; the last report per account stands.
      const latest = new Map(changes.map((change) => [change.userId, change]));
      let unfinished = false;
      for (const change of latest.values())
        await settleDirectoryChange(
          {
            prisma,
            pushTokens,
            devices: deviceSessions,
            events,
            afterDeparture: (actor, departure) =>
              afterSpaceDeparture({ prisma, sandbox, jobs, events }, actor, departure),
          },
          change,
        ).catch((error) => {
          unfinished = true;
          // Sign-in and runs are already refused. A retried update finishes the rest; after a
          // delete, the operator's `account-status.js deactivate` does.
          getLogger().error("directory.account_change.unfinished", error, {
            "user.id": change.userId,
          });
        });
      if (unfinished) {
        // The directory change committed. Failing the request makes the provider retry it.
        return c.json(
          {
            schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
            status: "500",
            detail: "Could not finish the change; retry it",
          },
          500,
          { "content-type": "application/scim+json" },
        );
      }
      return response;
    });
  }
  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    const path = new URL(c.req.url).pathname.replace("/api/auth", "");
    if (isBlockedAuthPath(path)) {
      return c.json({ error: "Not available in version 1" }, 404);
    }
    const ip = requestClientIp(c);
    const response = await withAuthLibraryFailures(() =>
      auth.handler(withClientIp(emptyAuthBodyAsJson(c.req.raw), ip)),
    );
    await auditAuthResponse(path, ip, response);
    return response;
  });
  mountLocalComputerHost(app, {
    token: env.desktopStackToken,
    sandboxProvider: env.sandboxProvider,
    prisma,
  });
  const requestSession = async (request: Request) => {
    // The bearer plugin turns a signed `Authorization: Bearer` into the session cookie.
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return null;
    const actor = await actorFromMembership(
      requireMembership(
        prisma,
        session.user.id,
        request.headers.get("x-rakazo-space-id"),
        session.session.id,
      ),
    );
    return actor && { actor, sessionId: session.session.id };
  };
  const sessionActor = async (request: Request) => (await requestSession(request))?.actor ?? null;
  if (userDeviceHub && userDevices) {
    mountUserDeviceRoutes(app, {
      prisma,
      hub: userDeviceHub,
      devices: userDevices,
      forwardSecret: userDeviceSecret,
      session: async (request) => {
        const found = await auth.api.getSession({ headers: request.headers });
        return found ? { userId: found.user.id, sessionId: found.session.id } : null;
      },
      trustedOrigin: (origin) => isTrustedOrigin(origin, env),
    });
  }
  if (messagingInstallations) {
    // Slack's registered redirect; the signed-in app finishes it so only the installer can.
    app.get("/api/v1/messaging/install/slack/callback", (c) => {
      const target = new URL("/messaging/slack/callback", env.webOrigin);
      target.search = new URL(c.req.url).search;
      return c.redirect(target.toString());
    });
  }
  app.use(
    "/rpc/*",
    clientBuildMiddleware({
      webBuild: readDeployedWebBuild(),
      minimums: env.minimumClientBuilds ?? {},
    }),
  );
  const limitRpcBody = rpcBodyLimit(env.maxUploadSizeBytes);
  app.use("/rpc/*", async (c, next) => {
    const session = await requestSession(c.req.raw);
    const actor = session?.actor ?? null;
    const tooLarge = await limitRpcBody(c, actor !== null);
    if (tooLarge) return tooLarge;
    if (actor) {
      enrichLogContext({ "user.id": actor.userId, "space.id": actor.spaceId });
    }
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: "/rpc",
      context: {
        actor,
        sessionId: session?.sessionId,
        signal: c.req.raw.signal,
        // Same user in the same space, so leaving the space also ends a stream.
        // A database failure rejects this check; only a missing membership is unauthorized.
        stillAuthorized: async () => {
          const current = await sessionActor(c.req.raw);
          return Boolean(
            actor && current?.userId === actor.userId && current.spaceId === actor.spaceId,
          );
        },
      },
    });
    if (!matched) return next();
    const reply = c.newResponse(response.body, response);
    if (requestHitDatabaseOutage())
      reply.headers.set("Retry-After", String(DATABASE_RETRY_AFTER_SECONDS));
    // A signed-in request that went through reached the database, so any outage is over.
    else if (actor && reply.status < 500) databaseOutage.succeeded();
    return reply;
  });
  mountAccountExportRoute(app, { prisma, auth, artifacts, home });
  mountAuditExportRoute(app, { prisma, sessionActor });
  mountVoiceHttpRoutes(app, { prisma, secrets, env }, async (c) => {
    const actor = await sessionActor(c.req.raw);
    if (actor) enrichLogContext({ "user.id": actor.userId, "space.id": actor.spaceId });
    return actor;
  });
  mountAccountImportRoute(
    app,
    {
      prisma,
      sandbox,
      home,
      jobs,
      memoryProviders,
      artifacts,
      dataDir: env.dataDir,
      messagingInstallations,
      maxArtifactBytes: env.maxUploadSizeBytes,
    },
    sessionActor,
  );
  mountWebhookHttpRoutes(app, { prisma, secrets, events, jobs });
  if (env.inboundEmail) {
    mountEmailInboundRoute(app, {
      prisma,
      events,
      jobs,
      ...env.inboundEmail,
      storeAttachment: ({ spaceId, userId, ...input }) =>
        storeInboundAttachment(
          { prisma, artifacts, maxUploadSizeBytes: env.maxUploadSizeBytes },
          { spaceId, userId },
          input,
        ),
    });
  }
  if (billing && billingProvider) {
    mountBillingRoutes(app, {
      billing,
      provider: billingProvider,
      webOrigin: env.webOrigin,
      authenticate: sessionActor,
    });
  }
  const messagingRuntime =
    messaging && messagingDelivery && teamChat
      ? await startMessagingRuntime({
          app,
          prisma,
          events,
          jobs,
          sandbox,
          secrets,
          artifacts,
          env,
          messaging,
          messagingInstallations,
          delivery: messagingDelivery,
          teamChat,
        })
      : undefined;

  app.route(
    "/",
    healthRoutes(
      () => ({
        runtime: env.agentRuntime,
        sandbox: env.sandboxProvider,
        integrations: [stack.composio, pipedream].flatMap((provider) =>
          provider ? [provider.describe().id] : [],
        ),
        messaging: Boolean(messaging),
        email: email?.describe().id ?? null,
        billing: billingProvider?.describe().id ?? null,
        jobs: jobKind,
        realtime: realtime.describe().id,
        secrets: secrets.describe(),
        degraded: secrets.describe().capabilities.degraded ?? false,
        revision: env.gitSha ?? null,
      }),
      // The statement timeout ends a stuck probe on the server too, freeing its connection.
      () =>
        prisma.$transaction([
          prisma.$executeRaw`SET LOCAL statement_timeout = 1500`,
          prisma.$queryRaw`SELECT 1`,
        ]),
    ),
  );

  return {
    app,
    prisma,
    jobs,
    sandbox,
    composio: stack.composio,
    connectors: stack.connector,
    messaging,
    email,
    notifications,
    executor,
    runtime,
    awaitIdle: inMemoryJobs ? () => inMemoryJobs.awaitIdle() : undefined,
    backgroundFailures: inMemoryJobs ? () => inMemoryJobs.failureCounts() : undefined,
    handleUpgrade: userDeviceHub?.handleUpgrade,
    stop: async () => {
      // Handlers still running would otherwise query the pool after it ends.
      const requestsSettled = settleWithTimeout(inFlight.settled(), REQUEST_DRAIN_MS);
      // Abort in-flight continueRun boot waits before draining jobs so stop() cannot sit
      // on waitForComputerReady for the full boot-wait window during shared Postgres journeys.
      auth.disposeOidcDiscovery();
      shutdown.abort();
      // Aborted runs hand themselves back while realtime is still open to announce them.
      const runsStopped = runs?.stop();
      await userDeviceHub?.close();
      await oauthLogins.abortAll();
      await messagingRuntime?.stop();
      await stopReferralEmails?.();
      await stopHomeRetention?.();
      await stopOrganizationDeletions();
      await reconciler?.stop();
      await oauthTokenUpgrade;
      await mcpArgsMove;
      await runsStopped;
      await requestsSettled;
      await botEmail?.drain?.();
      await email?.drain?.();
      await jobs.close();
      await secrets.close();
      await realtime.close();
      await mcp.close();
      await installed.close();
      await prisma.$disconnect().catch(() => undefined);
      await created.pool?.end().catch(() => undefined);
      await ownedJobPool?.end().catch(() => undefined);
      await analytics?.flush();
      await logger.flush({ timeoutMs: 2_000 });
    },
  };
}

export function isTrustedOrigin(
  origin: string,
  env: Pick<AppEnv, "webOrigin" | "apiUrl" | "authUrl"> & { extraAuthOrigins?: string[] },
) {
  if (!origin) return true;
  if (origin.startsWith("rakazo://")) return true;
  return new Set(trustedRequestOrigins(env)).has(origin);
}

export function trustedRequestOrigins(
  env: Pick<AppEnv, "webOrigin" | "apiUrl" | "authUrl"> & { extraAuthOrigins?: string[] },
) {
  return buildTrustedOrigins({
    origins: [env.webOrigin, env.apiUrl, env.authUrl, ...MOBILE_AUTH_ORIGINS],
    // Exactly as configured, like Better Auth's extraOrigins: no loopback twins.
    extraOrigins: env.extraAuthOrigins,
    requestOrigins: true,
  });
}

/**
 * No membership is no actor, which the RPC layer answers as 401. A database
 * failure, including the deployment-settings lookup, must stay a server error
 * so a blip does not look like a rejected session.
 */
export async function actorFromMembership(membership: Promise<Actor>): Promise<Actor | null> {
  try {
    return await membership;
  } catch (error) {
    if (error instanceof IsolationError) return null;
    throw error;
  }
}

type AuthLibraryFailure = { event: string; message: string; error?: Error };
const authLibraryFailures = new AsyncLocalStorage<AuthLibraryFailure[]>();

/**
 * The auth library logs a client's bad passkey or undeliverable address with the same call as its
 * own crashes, so a request holds them until its status says which they were.
 */
export function authLibraryLogger(event: string) {
  return {
    level: "error" as const,
    log: (_level: string, message: string, ...args: unknown[]) => {
      const error = args.find((arg): arg is Error => arg instanceof Error);
      // The request answers 503, and the outage logs once for all of them.
      if (error && failedOnDatabaseOutage(error)) return;
      const failure = { event, message, error };
      const held = authLibraryFailures.getStore();
      if (held) held.push(failure);
      else logAuthLibraryFailure(failure, true);
    },
  };
}

/** Reports the auth library's failures only when the request answers 5xx, otherwise warns. */
export async function withAuthLibraryFailures(handle: () => Promise<Response>) {
  const failures: AuthLibraryFailure[] = [];
  let crashed = true;
  try {
    const response = await authLibraryFailures.run(failures, handle);
    crashed = response.status >= 500;
    // The library answers its own 500 when the database is down; ask the client to retry.
    if (response.status === 500 && requestHitDatabaseOutage())
      return new Response("Service Unavailable", {
        status: 503,
        headers: { "Retry-After": String(DATABASE_RETRY_AFTER_SECONDS) },
      });
    // An auth request that went through read the database, so any outage is over.
    if (response.status < 400 && !requestHitDatabaseOutage()) databaseOutage.succeeded();
    return response;
  } finally {
    for (const failure of failures) logAuthLibraryFailure(failure, crashed);
  }
}

function logAuthLibraryFailure({ event, message, error }: AuthLibraryFailure, crashed: boolean) {
  // Without an error, the library is echoing a failure it already logged with one.
  if (crashed)
    getLogger().error(event, error ?? { "error.report": false, "error.message": message });
  else getLogger().warn(event, { error, "error.message": message });
}

/**
 * Some clients POST auth actions with an empty body (older phone sign-out, the web deletion code);
 * Better Auth rejects that before the endpoint runs.
 */
function emptyAuthBodyAsJson(request: Request) {
  if (
    request.method !== "POST" ||
    request.headers.get("content-length") !== "0" ||
    request.headers.has("transfer-encoding")
  ) {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Request(request, { headers, body: "{}" });
}
