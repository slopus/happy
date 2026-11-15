import type {
  AgentHomeStore,
  ArtifactStore,
  JobPublisher,
  MemoryStore,
  NotificationProvider,
  PaymentWalletProvider,
  ProductAnalytics,
  SandboxProvider,
  SecretStore,
  TransactionalEmailProvider,
} from "@rakazo/adapter-kit";
import type {
  CloudAgentConnection,
  CodexLiveCatalog,
  ComposioProvider,
  ConnectorRegistry,
  FaviconResolver,
  IntegrationProviderSettings,
  McpConnector,
  McpOAuthBroker,
  MemoryProviderResolver,
  MessagingDelivery,
  MessagingInstallations,
  PiOAuthLogins,
  PlanLimitsReader,
  PluginRepoFetcher,
  PluginTextReader,
  ProviderCatalogCache,
  PushTokenStore,
  RemoteConnectorDependencies,
  TicketChangeNotifier,
  UserCloudAgents,
  verifyModelServesAgents,
  WorkActivities,
} from "@rakazo/adapters";
import type { Auth } from "@rakazo/auth";
import type { ModelCredential, NavLink } from "@rakazo/contracts";
import type { BoardEvents, PrismaClient, ThreadEvents } from "@rakazo/db";
import type { BillingService } from "./billing.js";
import { accountRoutes } from "./routes/account.js";
import { availabilityRoutes } from "./routes/availability.js";
import { boardsRoutes } from "./routes/boards.js";
import { botsRoutes } from "./routes/bots.js";
import { capabilitiesRoutes } from "./routes/capabilities.js";
import { computerRoutes } from "./routes/computer.js";
import { computerProviderRoutes } from "./routes/computer-provider.js";
import { connectionsRoutes } from "./routes/connections.js";
import { contentRoutes } from "./routes/content.js";
import { createRouterContext } from "./routes/context.js";
import { mcpRoutes } from "./routes/mcp.js";
import { memoryRoutes } from "./routes/memory.js";
import { messagingRoutes } from "./routes/messaging.js";
import { modelsRoutes } from "./routes/models.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { organizationsRoutes } from "./routes/organizations.js";
import { pagesRoutes } from "./routes/pages.js";
import { paymentWalletRoutes } from "./routes/payment-wallet.js";
import { routinesRoutes } from "./routes/routines.js";
import { spacesRoutes } from "./routes/spaces.js";
import { spendingLimitRoutes } from "./routes/spending-limit.js";
import { threadsRoutes } from "./routes/threads.js";
import type { VoiceDeps } from "./voice.js";

export { nextConnectionLabel } from "./model-credentials.js";
export { botIntroPrompt, enqueueBotIntroRun } from "./routes/bots.js";
export { HEARTBEAT_MS, SESSION_RECHECK_MS } from "./routes/shared.js";
export { callMarkerClientNonce } from "./routes/threads.js";

export interface RouterDeps {
  pushTokens: PushTokenStore;
  /** Absent when the deployment cannot update a phone's live status card. */
  workActivities?: Pick<WorkActivities, "register" | "registerStarts">;
  /** Stops a call's ring on the owner's other devices once it is settled. */
  notifications?: NotificationProvider;
  analytics?: ProductAnalytics;
  cloudAgent?: CloudAgentConnection | null;
  userCloudAgents?: UserCloudAgents;
  /** The deployment's wallet provider; absent hides purchases. */
  paymentWallet?: PaymentWalletProvider | null;
  prisma: PrismaClient;
  events: ThreadEvents;
  boardEvents: BoardEvents;
  ticketChanges: TicketChangeNotifier;
  auth: Auth;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
  memory: MemoryStore;
  memoryProviders: MemoryProviderResolver;
  home: AgentHomeStore;
  secrets: SecretStore;
  oauthLogins: PiOAuthLogins<ModelCredential>;
  /** Live Codex catalog seam; defaults to the shared per-process cache. */
  codexCatalog?: CodexLiveCatalog;
  providerCatalog?: ProviderCatalogCache;
  /** Subscription allowance readings; defaults to the shared per-process cache. */
  planLimits?: PlanLimitsReader;
  /** HTTP transport for model connection checks and catalog probes. */
  modelConnectionFetch?: typeof fetch;
  /** One real request proving a newly keyed model can serve agents; absent skips it. */
  modelConnectionCheck?: typeof verifyModelServesAgents;
  /** Site icons for links; defaults to the per-process cache that fetches them. */
  favicons?: FaviconResolver;
  /** Detached refresh for an expired bearer, so the live catalog never refreshes inline. */
  refreshExpiredModelCredential?: (
    scope: { userId: string; spaceId: string },
    secretId: string,
    provider: string,
  ) => void;
  integrationSettings?: IntegrationProviderSettings;
  composio?: ComposioProvider;
  mcpOAuth?: McpOAuthBroker;
  /** Probes MCP server health; without it servers are never probed from here. */
  mcp?: Pick<McpConnector, "probe">;
  connectors: ConnectorRegistry;
  remoteConnectors?: RemoteConnectorDependencies;
  pluginRepoFetcher?: PluginRepoFetcher;
  pluginMarketplaceRead?: PluginTextReader;
  artifacts: ArtifactStore;
  dataDir: string;
  messagingInstallations?: MessagingInstallations;
  /** Sends replies to the chat apps people message from; absent without one. */
  messagingDelivery?: MessagingDelivery;
  messaging?: {
    enabled: boolean;
    providers: string[];
    addresses: Record<string, string>;
    openSignup: boolean;
  };
  /** Present only when the deployment bills; self-hosted installs leave it unset. */
  billing?: BillingService;
  email?: TransactionalEmailProvider;
  onEmailError?: (error: unknown) => void;
  speechSummary?: VoiceDeps["speechSummary"];
  env: {
    /** Domain of bots' email addresses; unset when this server receives no email. */
    inboundEmailDomain?: string;
    ticketBoardEnabled?: boolean;
    navLinks?: NavLink[];
    adminEmails?: string[];
    phoneCallsEnabled?: boolean;
    phoneCallRingSeconds?: number;
    maxUploadSizeBytes?: number;
    maxAttachmentsPerMessage?: number;
    agentRuntime: string;
    teamChatJudgeProvider?: string;
    teamChatJudgeModel?: string;
    defaultProvider: string;
    defaultModel: string;
    deploymentModelConfigured?: boolean;
    deploymentModelHostCredentials?: boolean;
    webOrigin: string;
    privacyPolicyUrl?: string;
    screenProxySecret: string;
    sandboxProvider: string;
    gitSha?: string;
    integrationsCatalogUrl?: string;
    mcpAllowPrivateEndpoint?: boolean;
    desktopHostChoiceEnabled?: boolean;
    computerSettingsEnabled?: boolean;
    mcpStdioEnabled?: boolean;
    mcpStdioAllowedCommands?: string[];
  };
}

export function createRouter(deps: RouterDeps) {
  const ctx = createRouterContext(deps);
  const { os } = ctx;

  return os.router({
    ...accountRoutes(ctx),
    ...spacesRoutes(ctx),
    ...organizationsRoutes(ctx),
    ...modelsRoutes(ctx),
    ...botsRoutes(ctx),
    ...threadsRoutes(ctx),
    ...computerRoutes(ctx),
    ...computerProviderRoutes(ctx),
    ...memoryRoutes(ctx),
    ...routinesRoutes(ctx),
    ...boardsRoutes(ctx),
    ...capabilitiesRoutes(ctx),
    ...mcpRoutes(ctx),
    ...onboardingRoutes(ctx),
    ...availabilityRoutes(ctx),
    ...connectionsRoutes(ctx),
    ...messagingRoutes(ctx),
    ...contentRoutes(ctx),
    ...pagesRoutes(ctx),
    ...paymentWalletRoutes(ctx),
    ...spendingLimitRoutes(ctx),
  });
}
