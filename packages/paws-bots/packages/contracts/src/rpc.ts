import type {
  AnyContractProcedure,
  InferContractRouterInputs,
  InferContractRouterOutputs,
} from "@orpc/contract";
import { eventIterator, oc } from "@orpc/contract";
import * as z from "zod";
import {
  AgentImportCreateInput,
  AgentImportPlanSchema,
  AgentImportPreviewInput,
} from "./agent-import.js";
import { AgentImportSetupStateInput, AgentImportSetupStateSchema } from "./agent-import-setup.js";
import { AiConsentQuerySchema, AiConsentStatusSchema } from "./ai-consent.js";
import { AnalyticsScreenInput } from "./analytics.js";
import {
  ARTIFACT_DESCRIPTION_MAX_LENGTH,
  ARTIFACT_NAME_MAX_LENGTH,
  ATTACHMENT_COUNT_CEILING,
} from "./attachments.js";
import { AuditEventListInputSchema, AuditEventPageSchema } from "./audit-events.js";
import {
  BillingClientSchema,
  BillingStatusSchema,
  ByokIntervalSchema,
  ByokTierSchema,
  ModelCreditAmountSchema,
} from "./billing.js";
import {
  BoardEventSchema,
  BoardSchema,
  CommentTicketInput,
  CreateTicketInput,
  GetTicketInput,
  ListTicketsInput,
  ListTicketsOutput,
  MoveTicketInput,
  RenameBoardInput,
  TicketCommentSchema,
  TicketSchema,
  UpdateTicketInput,
} from "./board.js";
import { BotAvatarSetSchema } from "./bot-avatar.js";
import { BotEmailAddressesSchema, BotEmailAddressSchema, BotEmailNameSchema } from "./bot-email.js";
import {
  BotSecretMetadata,
  BotSecretPutInput,
  LOGIN_FIELD_LIMIT,
  LoginFieldInput,
  StoredBotSecretName,
  VAULT_ACTIVITY_LIMIT,
  VaultPutInput,
  VaultRevealed,
  VaultRevealInput,
  VaultUse,
} from "./bot-secrets.js";
import {
  BotTemplateListingSchema,
  CreateBotFromTemplateInput,
  CreateBotFromTemplateOutput,
} from "./bot-template.js";
import {
  ComputerModeSchema,
  ComputerProviderSettingsSchema,
  ComputerProviderUpdateSchema,
  ComputerReleaseReasonSchema,
  ComputerStatusSchema,
  ComputerUpdateSchema,
} from "./computer.js";
import {
  AccessGrantInputSchema,
  AccessGrantSchema,
  AccountItemSchema,
  ActionApprovalRuleSchema,
  ActionAutoReviewSettingsSchema,
  AgentSecretInputSchema,
  AgentSecretSchema,
  AgentSkillCatalogEntrySchema,
  AgentSkillSchema,
  AppBootstrapSchema,
  AppLocaleSchema,
  ApprovalModeSchema,
  ArtifactSchema,
  ArtifactVersionSchema,
  ArtifactWithContentSchema,
  AvailabilityKindSchema,
  AvatarStyleSchema,
  BotSchema,
  BotSectionName,
  BotSectionSchema,
  CATALOG_SEARCH_QUERY_MAX_LENGTH,
  CapabilityInstallSchema,
  ChatAlertSchema,
  CONNECTION_LABEL_MAX_LENGTH,
  ConnectionCatalogItemSchema,
  ConnectionSchema,
  CreateAgentSkillInput,
  CreateBotInput,
  CreateGroupInput,
  CreateRoutineInput,
  CreateScratchpadItemInput,
  DeploymentSettingsSchema,
  ExportManifestSchema,
  ExternalConversationPolicySchema,
  GroupDetailSchema,
  GroupSchema,
  IncomingBotCallSchema,
  IntegrationCatalogResultSchema,
  MemoryDocumentSchema,
  MemoryPromptBudgetSchema,
  MemoryScopeSchema,
  MeSchema,
  MessagingAgentConnectionSchema,
  MessagingChannelMembershipSchema,
  MessagingInstallationsStatusSchema,
  MessagingLinkedIdentitySchema,
  MessagingStatusSchema,
  PlanLimitsSchema,
  PluginMarketplaceCatalogSchema,
  PluginPartSchema,
  PluginPreviewSchema,
  PluginSubmissionReviewSchema,
  PluginSubmissionSchema,
  PluginSubmissionStatusSchema,
  REPLY_QUOTE_MAX_LENGTH,
  ReorderBotsInput,
  ROUTINE_MENTION_BATCH_MAX,
  ROUTINE_TRIGGER_REQUIRED,
  RoutineEmailSendersSchema,
  RoutineSchema,
  ScratchpadItemSchema,
  ScratchpadItemStatusSchema,
  ServerUpdateCheckSchema,
  ServerUpdateRequestSchema,
  ServerUpdateRunSchema,
  ServerUpdateStatusSchema,
  SignupSurveySchema,
  SkillPlaybookSchema,
  SpaceInviteLinkSchema,
  SpaceInvitePreviewSchema,
  SpaceMembersSchema,
  SpaceMemoryConfigSchema,
  SpaceNavigationSchema,
  SpaceSchema,
  TaughtSkillSchema,
  TeachRecordingEventSchema,
  THREAD_MESSAGE_TEXT_MAX_LENGTH,
  ThreadMessagePageSchema,
  ThreadSnapshotSchema,
  TimeZoneSchema,
  UpdateAgentSkillInput,
  UpdateBotInput,
  UpdateExternalConversationPolicyInput,
  UpdateGroupInput,
  UsageRecordSchema,
  UsageSummarySchema,
  VoiceCatalogEntrySchema,
  VoiceCredentialSchema,
  VoiceInfoSchema,
  VoiceStatusSchema,
} from "./domain.js";
import { ComputerCommandSchema, ProductEventSchema } from "./events.js";
import { Id, IsoDate, ThinkingLevelSchema } from "./ids.js";
import {
  IntegrationProviderConfigSchema,
  IntegrationSetupStateSchema,
} from "./integration-settings.js";
import {
  BotMcpServerSchema,
  McpServerConfigInput,
  McpServerSchema,
  McpSourcePresetSchema,
} from "./mcp.js";
import {
  ModelApiProtocolSchema,
  ModelBackupChoiceSchema,
  ModelBackupListSchema,
  ModelCatalogEntrySchema,
  ModelConnectInputSchema,
  ModelConnectionLabelSchema,
  ModelConnectionTargetSchema,
  ModelCredentialSchema,
  ModelOAuthBeginSchema,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "./model-connections.js";
import { ModelHeadersSchema } from "./model-headers.js";
import { ModelRoleSchema, ModelRoleUpdateSchema, ModelRoleViewSchema } from "./model-roles.js";
import {
  PAGE_LIST_MAX_LIMIT,
  PageDetailSchema,
  PageSummarySchema,
  PageTitleSchema,
  PageVisibilitySchema,
} from "./pages.js";
import {
  PaymentWalletStatusSchema,
  SpendingLimitSchema,
  SpendingPaymentSchema,
  SpendingStatusSchema,
} from "./payments.js";
import { MessageReactionSchema } from "./reactions.js";
import { RoutineWatchSchema } from "./routine-watch.js";
import {
  ROUTINE_HISTORY_PAGE_SIZE,
  RoutineHistorySchema,
  RoutineRunCursorSchema,
  RunsListOutputSchema,
} from "./runs.js";
import { SearchQueryOutputSchema } from "./search.js";
import { SecurityEventListInputSchema, SecurityEventSchema } from "./security-events.js";
import { SettingsScopeSchema, SpaceSettingSchema, settingsScopeInput } from "./settings-scope.js";
import { SpaceAvailabilitySchema } from "./space-availability.js";
import { VaultImportInput, VaultImportResult } from "./vault-import.js";

const botId = z.object({ botId: Id });
const groupId = z.object({ groupId: Id });

const threadTarget = z
  .object({
    botId: Id.optional(),
    groupId: Id.optional(),
  })
  .superRefine((input, ctx) => {
    const hasBot = Boolean(input.botId);
    const hasGroup = Boolean(input.groupId);
    if (hasBot === hasGroup) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of botId or groupId",
        path: ["botId"],
      });
    }
  });

const structuredMentionTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bot"), id: Id }),
  z.object({ kind: z.literal("group"), id: Id }),
  z.object({ kind: z.literal("routine"), id: Id }),
  z.object({ kind: z.literal("connector"), id: Id }),
]);

const threadSendFields = threadTarget.safeExtend({
  imageHandling: z.enum(["confirm", "file"]).optional(),
  text: z.string().max(THREAD_MESSAGE_TEXT_MAX_LENGTH).optional(),
  artifactIds: z.array(Id).max(ATTACHMENT_COUNT_CEILING).optional(),
  /** Bare bot ids (legacy) or typed mention chips from the composer. */
  mentions: z
    .array(z.union([Id, structuredMentionTarget]))
    .max(64)
    .optional(),
  replyToMessageId: Id.optional(),
  replyQuote: z.string().trim().min(1).max(REPLY_QUOTE_MAX_LENGTH).optional(),
  /** Sent from the open page: a reply to its card that quotes nothing. */
  fromPage: z.literal(true).optional(),
  clientNonce: z.string().min(1).max(200).optional(),
});

export const threadSendInput = threadSendFields.superRefine((input, ctx) => {
  const text = input.text?.trim() ?? "";
  const artifactIds = input.artifactIds ?? [];
  if (!text && artifactIds.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "Provide text or at least one attachment",
      path: ["text"],
    });
  }
  if (input.replyQuote && !input.replyToMessageId) {
    ctx.addIssue({
      code: "custom",
      message: "replyQuote requires replyToMessageId",
      path: ["replyQuote"],
    });
  }
});

const threadSendOutput = z.object({
  taskId: Id,
  runId: Id,
  seq: z.number().int(),
  runIds: z.array(Id).optional(),
});

/** Without text or attachments, only the routines run and no message is saved. */
const threadSendWithRoutinesInput = threadSendFields.safeExtend({
  clientNonce: z.string().min(1).max(200),
  routineIds: z.array(Id).min(1).max(64),
});

const spaceName = z.string().trim().min(1).max(60);
const organizationName = spaceName;
/** Every organization the signed-in user belongs to, and which one the current Space belongs to. */
export const OrganizationListSchema = z.object({
  activeOrganizationId: Id,
  organizations: z.array(
    z.object({
      id: Id,
      name: z.string(),
      defaultSpaceId: Id,
      spaceIds: z.array(Id),
      /** Whether the user owns it, so can rename or delete it. */
      canManage: z.boolean(),
    }),
  ),
});
export type OrganizationList = z.infer<typeof OrganizationListSchema>;

export const appContract = {
  analytics: { screen: oc.input(AnalyticsScreenInput).output(z.object({ ok: z.literal(true) })) },
  aiConsent: {
    status: oc.input(AiConsentQuerySchema).output(AiConsentStatusSchema),
    allow: oc
      .input(
        z.object({
          scope: z.string(),
          version: z.string(),
          keys: z.array(z.string()).min(1).max(200),
          /** The settings copy the reviewed recipients came from, as in `status`. */
          settingsScope: SettingsScopeSchema.optional(),
        }),
      )
      .output(AiConsentStatusSchema),
    revoke: oc.input(z.object({ key: z.string().nullable() })).output(AiConsentStatusSchema),
  },
  health: oc.output(z.object({ ok: z.literal(true), version: z.string() })),
  me: oc.output(MeSchema),
  billing: {
    /** Claims an invite code first when one is sent, so the status already reflects it. */
    status: oc
      .input(z.object({ referralCode: z.string().min(1).max(64).optional() }).optional())
      .output(BillingStatusSchema),
    /** Re-reads the subscription from the provider, e.g. right after a mobile checkout. */
    refresh: oc.output(BillingStatusSchema),
    selectFunding: oc
      .input(
        z.object({
          funding: z.enum(["byok", "credits"]),
          client: BillingClientSchema,
          /** Billing period of the own-key plan's checkout; monthly when omitted. */
          interval: ByokIntervalSchema.optional(),
          /** The own-key plan's tier; Standard when omitted. */
          tier: ByokTierSchema.optional(),
        }),
      )
      /** `url` is the checkout to pay for the own-key plan before it has access. */
      .output(z.object({ ok: z.literal(true), url: z.string().url().optional() })),
    purchaseCredits: oc
      .input(
        z.object({
          amountCents: ModelCreditAmountSchema,
          monthly: z.boolean(),
          client: BillingClientSchema,
        }),
      )
      .output(z.object({ url: z.string().url() })),
    setMonthlyCredits: oc
      .input(z.object({ amountCents: ModelCreditAmountSchema }))
      .output(z.object({ ok: z.literal(true) })),
    checkout: oc
      .input(
        z
          .object({
            client: BillingClientSchema,
            interval: ByokIntervalSchema.optional(),
            /** The own-key plan's tier; Standard when omitted. */
            tier: ByokTierSchema.optional(),
          })
          .optional(),
      )
      .output(z.object({ url: z.string().url() })),
    portal: oc
      .input(z.object({ client: BillingClientSchema }).optional())
      .output(z.object({ url: z.string().url() })),
    /** Owners only: ends the running trial and bills the first period now. */
    endTrial: oc.output(BillingStatusSchema),
    /** Owners only: moves a monthly own-key plan to yearly, charging the difference now. */
    switchToYearly: oc.output(BillingStatusSchema),
    /** Owners only: moves the own-key plan to another tier at the same interval, billing the difference now. */
    changeTier: oc.input(z.object({ tier: ByokTierSchema })).output(BillingStatusSchema),
    /** Records who invited this organization; ignored once it has subscribed. */
    claimReferral: oc
      .input(z.object({ code: z.string().min(1).max(64) }))
      .output(z.object({ ok: z.literal(true) })),
  },
  /** Admins only, on deployments that sell model credits. */
  accessGrants: {
    list: oc.output(z.array(AccessGrantSchema)),
    create: oc.input(AccessGrantInputSchema).output(AccessGrantSchema),
    revoke: oc.input(z.object({ id: Id })).output(AccessGrantSchema),
  },
  preferences: {
    update: oc
      .input(
        z
          .object({
            avatarStyle: AvatarStyleSchema.optional(),
            /** Restyles every bot not pinned to another set, and is what new bots get. */
            botAvatarSet: BotAvatarSetSchema.optional(),
            timezone: TimeZoneSchema.nullable().optional(),
            /** The language the app runs in, so emails can be written in it. */
            locale: AppLocaleSchema.optional(),
          })
          .refine(
            (input) =>
              input.avatarStyle !== undefined ||
              input.botAvatarSet !== undefined ||
              input.timezone !== undefined ||
              input.locale !== undefined,
            { message: "Nothing to update" },
          ),
      )
      .output(MeSchema),
    /** Saves a detected timezone only while none is saved, so it never replaces a choice. */
    adoptTimezone: oc.input(z.object({ timezone: TimeZoneSchema })).output(MeSchema),
  },
  spaces: {
    list: oc.output(SpaceNavigationSchema),
    create: oc.input(z.object({ name: spaceName })).output(SpaceSchema),
    rename: oc
      .input(z.object({ spaceId: Id, name: spaceName }))
      .output(z.object({ id: Id, name: z.string() })),
    remove: oc
      .input(z.object({ spaceId: Id }))
      .output(z.object({ ok: z.literal(true), activeSpaceId: Id })),
    members: {
      list: oc.input(z.object({ spaceId: Id })).output(SpaceMembersSchema),
      /** Owner only. The removed person's bots, chats and routines stay with the space. */
      remove: oc
        .input(z.object({ spaceId: Id, userId: Id }))
        .output(z.object({ ok: z.literal(true) })),
      /** Members only; an owner deletes the space instead. */
      leave: oc
        .input(z.object({ spaceId: Id }))
        .output(z.object({ ok: z.literal(true), activeSpaceId: Id })),
    },
    invites: {
      /** Owner only. A new single-use link each call. */
      create: oc.input(z.object({ spaceId: Id })).output(SpaceInviteLinkSchema),
      preview: oc
        .input(z.object({ token: z.string().min(1).max(200) }))
        .output(SpaceInvitePreviewSchema),
      accept: oc
        .input(z.object({ token: z.string().min(1).max(200) }))
        .output(z.object({ spaceId: Id })),
      /** Owner only. Every unused link stops working, for one that went to the wrong place. */
      cancel: oc.input(z.object({ spaceId: Id })).output(z.object({ ok: z.literal(true) })),
    },
  },
  organizations: {
    list: oc.output(OrganizationListSchema),
    create: oc
      .input(z.object({ name: organizationName }))
      .output(z.object({ id: Id, name: z.string(), defaultSpaceId: Id })),
    rename: oc
      .input(z.object({ organizationId: Id, name: organizationName }))
      .output(z.object({ id: Id, name: z.string() })),
    remove: oc
      .input(z.object({ organizationId: Id }))
      .output(z.object({ ok: z.literal(true), activeSpaceId: Id })),
  },
  bootstrap: oc.input(z.object({ botId: Id.optional() })).output(AppBootstrapSchema),
  deployment: {
    get: oc.output(DeploymentSettingsSchema),
    update: oc
      .input(
        z.object({
          signupsEnabled: z.boolean().optional(),
          signupAllowlist: z.array(z.string()).optional(),
          computerHost: z.enum(["docker", "this-mac"]).nullable().optional(),
        }),
      )
      .output(DeploymentSettingsSchema),
  },
  /** Admin choice of where new computers run, with that provider's connection settings. */
  computerProvider: {
    get: oc.output(ComputerProviderSettingsSchema),
    update: oc.input(ComputerProviderUpdateSchema).output(ComputerProviderSettingsSchema),
    /** The signed-in account's provider for Team Computers, over the default. */
    account: {
      get: oc.output(ComputerProviderSettingsSchema),
      update: oc.input(ComputerProviderUpdateSchema).output(ComputerProviderSettingsSchema),
    },
  },
  /** Deployment-owner view of the append-only security event log, newest first. */
  security: {
    events: oc.input(SecurityEventListInputSchema).output(z.array(SecurityEventSchema)),
  },
  /** The organization's audit log, newest first. Organization owners and admins only. */
  audit: {
    events: oc.input(AuditEventListInputSchema).output(AuditEventPageSchema),
  },
  /**
   * Deployment-owner product updates. When the Compose updater sidecar is reachable, these proxy
   * to its `/state` `/plan` `/apply` contract. Rollback stays on the sidecar for ops only and is
   * not exposed here. Never git-fetch from the API process.
   */
  updater: {
    status: oc.output(ServerUpdateStatusSchema),
    check: oc.input(ServerUpdateRequestSchema).output(ServerUpdateCheckSchema),
    apply: oc.input(ServerUpdateRequestSchema).output(ServerUpdateRunSchema),
  },
  models: {
    forRole: oc
      .input(z.object({ role: ModelRoleSchema, expectedUserId: Id.optional() }))
      .output(z.array(ModelCatalogEntrySchema)),
    role: oc
      .input(
        z.object({
          role: ModelRoleSchema,
          expectedUserId: Id.optional(),
          scope: SettingsScopeSchema.optional(),
        }),
      )
      .output(ModelRoleViewSchema),
    setRole: oc
      .input(
        ModelRoleUpdateSchema.extend({
          role: ModelRoleSchema,
          expectedUserId: Id.optional(),
          scope: SettingsScopeSchema.optional(),
        }),
      )
      .output(ModelRoleViewSchema),
    list: oc.output(z.array(ModelCatalogEntrySchema)),
    credentials: oc.output(z.array(ModelCredentialSchema)),
    backups: oc.output(z.array(ModelBackupChoiceSchema)),
    setBackups: oc.input(ModelBackupListSchema).output(z.object({ ok: z.literal(true) })),
    connect: oc.input(ModelConnectInputSchema).output(ModelCredentialSchema),
    probeOpenAiCompatible: oc
      .input(
        z.object({
          baseUrl: z.string(),
          credentialId: z.string().optional(),
          headers: ModelHeadersSchema.optional(),
          apiKey: z.string().optional(),
          apiProtocol: ModelApiProtocolSchema.optional(),
        }),
      )
      .output(z.object({ models: z.array(z.string()) })),
    probeCatalog: oc
      .input(
        z.object({
          provider: z.string().trim().min(1),
          apiKey: z.string().trim().min(8),
        }),
      )
      .output(z.object({ models: z.array(z.string()) })),
    beginOAuth: oc
      .input(
        z.object({
          provider: z.string(),
          label: z.string().optional(),
          /** Signs an existing connection in again; null adds another, as connect does. */
          credentialId: ModelConnectionTargetSchema,
          modelId: z.string().optional(),
          thinkingLevel: ThinkingLevelSchema.nullable().optional(),
          makeDefault: z.boolean().optional(),
          scope: SettingsScopeSchema.optional(),
          /** No loopback listener (web, mobile): the provider shows a code to paste instead. */
          codePage: z.boolean().optional(),
        }),
      )
      .output(ModelOAuthBeginSchema),
    submitOAuthCode: oc
      .input(z.object({ loginId: z.string(), code: z.string().trim().min(1).max(8_192) }))
      .output(z.object({ ok: z.literal(true) })),
    completeOAuth: oc
      .input(z.object({ loginId: z.string() }))
      .output(
        z.discriminatedUnion("status", [
          z.object({ status: z.literal("pending") }),
          z.object({ status: z.literal("ready") }),
          z.object({ status: z.literal("error"), error: z.string() }),
        ]),
      ),
    finishOAuth: oc.input(z.object({ loginId: z.string() })).output(ModelCredentialSchema),
    cancelOAuth: oc
      .input(z.object({ loginId: z.string() }))
      .output(z.object({ ok: z.literal(true) })),
    setDefault: oc
      .input(
        z.object({
          provider: z.string(),
          modelId: z.string(),
          thinkingLevel: ThinkingLevelSchema.nullable().optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    rename: oc
      .input(z.object({ credentialId: Id, label: ModelConnectionLabelSchema }))
      .output(z.object({ ok: z.literal(true) })),
    /** Removes one connection, or every connection of the provider when older apps omit it. */
    disconnect: oc
      .input(z.object({ provider: z.string().trim().min(1), credentialId: Id.optional() }))
      .output(z.object({ ok: z.literal(true) })),
  },
  bots: {
    list: oc.output(z.array(BotSchema)),
    listArchived: oc.output(z.array(BotSchema)),
    get: oc.input(botId).output(BotSchema),
    create: oc.input(CreateBotInput).output(BotSchema),
    importPreview: oc.input(AgentImportPreviewInput).output(AgentImportPlanSchema),
    importCreate: oc.input(AgentImportCreateInput).output(BotSchema),
    importSetupState: oc.input(AgentImportSetupStateInput).output(AgentImportSetupStateSchema),
    templates: oc.output(z.array(BotTemplateListingSchema)),
    createFromTemplate: oc.input(CreateBotFromTemplateInput).output(CreateBotFromTemplateOutput),
    duplicate: oc.input(botId).output(BotSchema),
    reorder: oc.input(ReorderBotsInput).output(z.object({ ok: z.literal(true) })),
    update: oc.input(UpdateBotInput).output(BotSchema),
    restoreInstructions: oc
      .input(
        z.object({
          botId: Id,
          versionId: Id,
          expectedInstructions: z.string(),
          undo: z.boolean().optional(),
        }),
      )
      .output(BotSchema),
    setComputer: oc.input(z.object({ botId: Id, mode: ComputerModeSchema })).output(BotSchema),
    archive: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    restore: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    remove: oc
      .input(z.object({ botId: Id, deleteMemories: z.boolean().default(false) }))
      // Optional for clients talking to older servers; current servers return committed group IDs.
      .output(
        z.object({
          ok: z.literal(true),
          removedGroupIds: z.array(Id).optional(),
          alreadyRemoved: z.boolean().optional(),
        }),
      ),
    /** Groups this delete removes because fewer than two active bots would remain. */
    removePreview: oc.input(botId).output(z.array(z.object({ id: Id, name: z.string() }))),
    emailAddress: oc.input(botId).output(BotEmailAddressSchema),
    emailAddresses: oc.output(BotEmailAddressesSchema),
    claimEmailAddress: oc
      .input(z.object({ botId: Id, name: BotEmailNameSchema }))
      .output(z.object({ address: z.string() })),
    rotateWebhookSecret: oc.input(botId).output(
      z.object({
        secret: z.string(),
        path: z.string(),
        webhookConfigured: z.literal(true),
      }),
    ),
    revealWebhookSecret: oc.input(botId).output(z.object({ secret: z.string() })),
  },
  groups: {
    create: oc.input(CreateGroupInput).output(GroupSchema),
    list: oc.output(z.array(GroupSchema)),
    listArchived: oc.output(z.array(GroupSchema)),
    get: oc.input(groupId).output(GroupDetailSchema),
    duplicate: oc.input(groupId).output(GroupSchema),
    update: oc.input(UpdateGroupInput).output(GroupSchema),
    archive: oc.input(groupId).output(z.object({ ok: z.literal(true) })),
    restore: oc.input(groupId).output(z.object({ ok: z.literal(true) })),
    remove: oc.input(groupId).output(z.object({ ok: z.literal(true) })),
  },
  botSections: {
    list: oc.output(z.array(BotSectionSchema)),
    create: oc.input(threadTarget.safeExtend({ name: BotSectionName })).output(BotSectionSchema),
    update: oc.input(z.object({ sectionId: Id, name: BotSectionName })).output(BotSectionSchema),
    remove: oc.input(z.object({ sectionId: Id })).output(
      z.object({
        id: Id,
        releasedBots: z.number().int().nonnegative(),
        releasedGroups: z.number().int().nonnegative(),
      }),
    ),
  },
  threads: {
    head: oc.input(threadTarget).output(
      z.object({
        threadId: Id,
        cursor: z.number().int().min(-1),
      }),
    ),
    get: oc.input(threadTarget).output(ThreadSnapshotSchema),
    messages: oc
      .input(
        threadTarget.safeExtend({
          before: z.number().int().nonnegative().optional(),
          includePeerRuns: z.boolean().optional(),
          includePeerReceipts: z.boolean().optional(),
          around: z
            .object({
              messageId: Id.optional(),
              seq: z.number().int().nonnegative().optional(),
            })
            .optional(),
        }),
      )
      .output(ThreadMessagePageSchema),
    subscribe: oc
      .input(threadTarget.safeExtend({ cursor: z.number().int().min(-1) }))
      .output(eventIterator(ProductEventSchema)),
    send: oc.input(threadSendInput).output(threadSendOutput),
    /**
     * A send that also test-runs the mentioned routines: the message and every run commit
     * together, keyed by the nonce. A separate procedure, because an API without it must
     * reject the call rather than strip the routines and send only the text.
     */
    sendWithRoutines: oc
      .input(threadSendWithRoutinesInput)
      .output(z.object({ routineRunIds: z.array(Id), send: threadSendOutput.optional() })),
    react: oc
      .input(
        threadTarget.safeExtend({
          messageId: Id,
          reaction: MessageReactionSchema,
          clientNonce: z.string().min(1).max(200),
        }),
      )
      .output(z.object({ ok: z.literal(true), runIds: z.array(Id).optional() })),
    stop: oc.input(threadTarget).output(z.object({ ok: z.literal(true) })),
    // Its own route, so a server without it refuses rather than stopping the whole chat.
    stopHelper: oc
      .input(threadTarget.safeExtend({ messageId: Id }))
      .output(z.object({ ok: z.literal(true) })),
    followUp: oc
      .input(
        threadTarget.safeExtend({
          text: z.string().min(1),
          /** Carries the call id, so a turn taken mid-run stays in the call's card. */
          clientNonce: z.string().min(1).max(200).optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    /** The client hung up: close the call card and let the bot finish what was asked on it. */
    endCall: oc
      // ":" separates the call id from the nonce suffix, so it can never appear inside one.
      .input(
        botId.safeExtend({
          callId: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[^:]+$/),
          /** How long the call was connected, measured from pickup on the caller's client. */
          durationSeconds: z
            .number()
            .int()
            .nonnegative()
            .max(7 * 24 * 60 * 60)
            .optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    /** The user picked up the bot's call: returns what the bot opens with. */
    answerCall: oc
      .input(
        botId.safeExtend({
          callId: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[^:]+$/),
        }),
      )
      .output(z.object({ opening: z.string(), reason: z.string() })),
    /** The user turned the bot's call down, asked for it later, or it rang out. */
    declineCall: oc
      .input(
        botId.safeExtend({
          callId: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[^:]+$/),
          outcome: z.enum(["declined", "missed"]),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    clear: oc.input(threadTarget).output(z.object({ ok: z.literal(true) })),
    answer: oc
      .input(
        threadTarget
          .safeExtend({
            runId: Id,
            messageId: Id,
            answer: z.string(),
            /** Carries the call id for an answer spoken during a call. */
            clientNonce: z.string().min(1).max(200).optional(),
            /** A login card's answer, one per requested field; `answer` is then empty. */
            fields: z.array(LoginFieldInput).min(1).max(LOGIN_FIELD_LIMIT).optional(),
            /** A login card's answer from apps that predate `fields`; `answer` carries its password. */
            username: z.string().min(1).max(512).optional(),
            /** Only for a login card: use the login for this run only instead of saving it. */
            remember: z.literal(false).optional(),
            /** Turns down a pending secret request; `answer` is then empty. */
            dismiss: z.literal(true).optional(),
          })
          .refine(
            (input) => input.remember === undefined || Boolean(input.fields ?? input.username),
            {
              message: "Only a website login can be used without saving it",
              path: ["remember"],
            },
          )
          .refine(
            (input) =>
              input.dismiss
                ? input.answer === "" && !input.username && !input.fields && !input.clientNonce
                : input.fields
                  ? input.answer === "" && !input.username
                  : input.answer.length > 0,
            "Send either an answer or a dismissal",
          ),
      )
      .output(z.object({ ok: z.literal(true) })),
    /** `unreadAfterSeq`: the seq read up to before this call, null when nothing was unread. */
    markRead: oc
      .input(threadTarget)
      .output(z.object({ ok: z.literal(true), unreadAfterSeq: z.number().int().nullable() })),
    /** With `messageId`, the chat reads as unread from that message: the next open puts New above it. */
    markUnread: oc
      .input(threadTarget.and(z.object({ messageId: Id.optional() })))
      .output(z.object({ ok: z.literal(true) })),
    /** Hides the chat from the caller's list until `until`; null wakes it now. */
    snooze: oc
      .input(threadTarget.and(z.object({ until: z.iso.datetime({ offset: true }).nullable() })))
      .output(z.object({ ok: z.literal(true) })),
  },
  computer: {
    status: oc.input(botId).output(ComputerStatusSchema),
    boot: oc.input(botId).output(ComputerStatusSchema),
    stop: oc.input(botId).output(ComputerStatusSchema),
    recover: oc.input(botId).output(ComputerUpdateSchema),
    reset: oc.input(botId).output(ComputerStatusSchema),
    update: oc.input(botId).output(ComputerUpdateSchema),
    updates: oc.output(z.array(ComputerUpdateSchema)),
    releaseInterrupted: oc
      .input(z.object({ id: Id, workersStopped: z.literal(true) }))
      .output(z.object({ ok: z.literal(true) })),
    dismissUpdate: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
    dismissDiskWarning: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    takeover: oc.input(botId).output(z.object({ leaseId: Id, expiresAt: z.string() })),
    release: oc
      .input(
        z.object({
          botId: Id,
          reason: ComputerReleaseReasonSchema.optional(),
          /** The run a needs-you card answers; the release applies only while it waits on the caller. */
          runId: Id.optional(),
          /** The lease this page took; a late release from an old page leaves newer control alone. */
          leaseId: Id.optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    input: oc
      .input(
        z.object({
          botId: Id,
          kind: z.enum(["key", "pointer", "clipboard", "scroll"]),
          payload: z.record(z.string(), z.unknown()),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    files: oc
      .input(z.object({ botId: Id, path: z.string().default("/") }))
      .output(
        z.array(z.object({ path: z.string(), kind: z.enum(["file", "dir"]), size: z.number() })),
      ),
    readFile: oc
      .input(z.object({ botId: Id, path: z.string() }))
      .output(z.object({ path: z.string(), content: z.string() })),
    downloadFile: oc
      .input(z.object({ botId: Id, path: z.string().min(1) }))
      .output(z.object({ path: z.string(), contentBase64: z.string() })),
    uploadFile: oc
      .input(
        z.object({
          botId: Id,
          path: z.string().min(1),
          contentBase64: z.string(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    terminalUrl: oc.input(botId).output(z.object({ url: z.string().nullable() })),
    commands: oc
      .input(botId)
      .output(z.array(ComputerCommandSchema.extend({ createdAt: z.string() }))),
    screenUrl: oc.input(botId).output(z.object({ url: z.string().nullable() })),
    /** A still of the screen as an image data URL, or null when the computer is not running. */
    preview: oc
      .input(
        z.object({
          botId: Id,
          /** The run a needs-you card shows; no image once that run stops waiting. */
          runId: Id.optional(),
        }),
      )
      .output(z.object({ image: z.string().nullable() })),
    heartbeat: oc.input(botId).output(z.object({ ok: z.literal(true) })),
  },
  memory: {
    list: oc
      .input(z.object({ botId: Id.optional(), scope: z.enum(["bot", "user"]).optional() }))
      .output(z.array(MemoryDocumentSchema)),
    budget: oc.input(z.object({ botId: Id })).output(MemoryPromptBudgetSchema),
    update: oc
      .input(
        z.object({
          documentId: Id,
          content: z.string(),
          expectedRevision: z.number().int().positive().optional(),
        }),
      )
      .output(MemoryDocumentSchema),
    remove: oc.input(z.object({ documentId: Id })).output(z.object({ ok: z.literal(true) })),
    exportMarkdown: oc.input(z.object({ botId: Id.optional() })).output(z.string()),
    providerConfig: oc.output(SpaceMemoryConfigSchema.nullable()),
    connectProvider: oc
      .input(
        z.object({
          provider: z.string().min(1),
          settings: z.record(z.string(), z.string()),
          credentials: z.record(z.string(), z.string()),
          defaultMemoryScope: MemoryScopeSchema.default("isolated"),
        }),
      )
      .output(SpaceMemoryConfigSchema),
    setDefaultScope: oc
      .input(z.object({ defaultMemoryScope: MemoryScopeSchema }))
      .output(SpaceMemoryConfigSchema),
    disconnectProvider: oc.output(z.object({ ok: z.literal(true) })),
  },
  routines: {
    listForMentions: oc
      .input(z.object({ botIds: z.array(Id).min(1).max(ROUTINE_MENTION_BATCH_MAX) }))
      .output(z.array(z.object({ botId: Id, routines: z.array(RoutineSchema) }))),
    list: oc.input(botId).output(z.array(RoutineSchema)),
    history: oc
      .input(
        z.object({
          routineId: Id,
          before: RoutineRunCursorSchema.optional(),
          limit: z.number().int().min(1).max(ROUTINE_HISTORY_PAGE_SIZE).optional(),
        }),
      )
      .output(RoutineHistorySchema),
    create: oc.input(CreateRoutineInput).output(RoutineSchema),
    update: oc
      .input(
        z
          .object({
            routineId: Id,
            name: z.string().optional(),
            prompt: z.string().optional(),
            crons: z.array(z.string().min(1)).optional(),
            timezone: TimeZoneSchema.optional(),
            active: z.boolean().optional(),
            notify: z.boolean().optional(),
            webhookEnabled: z.boolean().optional(),
            githubEnabled: z.boolean().optional(),
            messageProvider: z
              .string()
              .min(1)
              .max(50)
              .regex(/^[a-z0-9._-]+$/i)
              .nullable()
              .optional(),
            /** Null removes the email trigger. */
            emailSenders: RoutineEmailSendersSchema.nullable().optional(),
            /** Null clears the routine's own model and runs it on the bot's. */
            modelProvider: z.string().trim().min(1).max(80).nullable().optional(),
            modelId: z.string().trim().min(1).max(200).nullable().optional(),
            thinkingLevel: ThinkingLevelSchema.nullable().optional(),
            /** ISO datetime to arm a never-run one-shot. */
            runAt: IsoDate.optional(),
            /** Null removes the change trigger. */
            watch: RoutineWatchSchema.nullable().optional(),
          })
          .superRefine((value, ctx) => {
            if (
              value.crons &&
              value.crons.length === 0 &&
              value.webhookEnabled === false &&
              value.githubEnabled === false &&
              value.messageProvider === null &&
              value.emailSenders === null &&
              value.watch === null
            ) {
              ctx.addIssue({
                code: "custom",
                message: ROUTINE_TRIGGER_REQUIRED,
                path: ["crons"],
              });
            }
          }),
      )
      .output(RoutineSchema),
    remove: oc.input(z.object({ routineId: Id })).output(z.object({ ok: z.literal(true) })),
    testRun: oc
      .input(
        z.object({
          routineId: Id,
          clientNonce: z.string().min(1).max(200).optional(),
        }),
      )
      .output(z.object({ runId: Id })),
  },
  scratchpad: {
    list: oc
      .input(
        z.object({
          botId: Id,
          status: ScratchpadItemStatusSchema.optional(),
          includeDone: z.boolean().optional(),
        }),
      )
      .output(z.array(ScratchpadItemSchema)),
    create: oc.input(CreateScratchpadItemInput).output(ScratchpadItemSchema),
    update: oc
      .input(
        z.object({
          itemId: Id,
          title: z.string().min(1).max(200).optional(),
          status: ScratchpadItemStatusSchema.optional(),
          notes: z.string().max(4_000).optional(),
        }),
      )
      .output(ScratchpadItemSchema),
    remove: oc.input(z.object({ itemId: Id })).output(z.object({ ok: z.literal(true) })),
  },
  boards: {
    list: oc.output(z.array(BoardSchema)),
    get: oc.output(BoardSchema),
    rename: oc.input(RenameBoardInput).output(BoardSchema),
    subscribe: oc.output(eventIterator(BoardEventSchema)),
  },
  tickets: {
    list: oc.input(ListTicketsInput).output(ListTicketsOutput),
    get: oc.input(GetTicketInput).output(TicketSchema),
    create: oc.input(CreateTicketInput).output(TicketSchema),
    update: oc.input(UpdateTicketInput).output(TicketSchema),
    move: oc.input(MoveTicketInput).output(TicketSchema),
    comment: oc.input(CommentTicketInput).output(TicketCommentSchema),
    comments: oc.input(z.object({ ticketId: Id })).output(z.array(TicketCommentSchema)),
  },
  skills: {
    list: oc.input(botId).output(z.array(TaughtSkillSchema)),
    get: oc.input(z.object({ skillId: Id })).output(TaughtSkillSchema),
    start: oc
      .input(z.object({ botId: Id, goal: z.string().min(1).max(4000) }))
      .output(TaughtSkillSchema),
    appendEvent: oc
      .input(z.object({ skillId: Id, event: TeachRecordingEventSchema }))
      .output(TaughtSkillSchema),
    snapshot: oc.input(z.object({ skillId: Id })).output(TaughtSkillSchema),
    stop: oc.input(z.object({ skillId: Id })).output(TaughtSkillSchema),
    updateDraft: oc
      .input(
        z.object({
          skillId: Id,
          name: z.string().optional(),
          playbook: SkillPlaybookSchema,
        }),
      )
      .output(TaughtSkillSchema),
    save: oc
      .input(z.object({ skillId: Id, name: z.string().optional() }))
      .output(TaughtSkillSchema),
    testRun: oc
      .input(z.object({ skillId: Id, prompt: z.string().optional() }))
      .output(z.object({ runId: Id })),
    remove: oc.input(z.object({ skillId: Id })).output(z.object({ ok: z.literal(true) })),
  },
  /** Claude Agent Skills (SKILL.md recipes) shared across assistants (not taught/demo skills). */
  agentSkills: {
    list: oc.output(z.array(AgentSkillCatalogEntrySchema)),
    get: oc
      .input(
        z
          .object({ skillId: Id.optional(), name: z.string().min(1).max(80).optional() })
          .superRefine((input, ctx) => {
            if (!input.skillId && !input.name?.trim()) {
              ctx.addIssue({
                code: "custom",
                message: "Provide skillId or name",
                path: ["skillId"],
              });
            }
          }),
      )
      .output(AgentSkillSchema),
    create: oc.input(CreateAgentSkillInput).output(AgentSkillSchema),
    update: oc.input(UpdateAgentSkillInput).output(AgentSkillSchema),
    remove: oc.input(z.object({ skillId: Id })).output(z.object({ ok: z.literal(true) })),
  },
  availability: {
    set: oc
      .input(z.object({ kind: AvailabilityKindSchema, id: Id }).and(SpaceAvailabilitySchema))
      .output(SpaceAvailabilitySchema),
    /** The user's own skills, MCP servers, plugins and tool sources across their spaces. */
    items: oc.output(z.array(AccountItemSchema)),
    /** Make exactly the listed items available in a space, keeping each one's other spaces. */
    chooseForSpace: oc
      .input(
        z.object({
          spaceId: Id,
          items: z.array(z.object({ kind: AvailabilityKindSchema, id: Id })).max(500),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
  },
  marketplace: {
    catalog: oc
      .input(z.object({ query: z.string().trim().max(200).default("") }))
      .output(PluginMarketplaceCatalogSchema),
    /** Admins only. */
    submissions: oc
      .input(z.object({ status: PluginSubmissionStatusSchema.default("pending") }))
      .output(z.array(PluginSubmissionSchema)),
    /** Admins only. */
    review: oc.input(PluginSubmissionReviewSchema).output(PluginSubmissionSchema),
  },
  capabilities: {
    list: oc.output(z.array(CapabilityInstallSchema)),
    sourcePresets: oc.output(z.array(McpSourcePresetSchema)),
    catalogSearch: oc
      .input(
        z.object({
          query: z.string().trim().max(CATALOG_SEARCH_QUERY_MAX_LENGTH).default(""),
          usePublicCatalog: z.boolean().default(false),
        }),
      )
      .output(
        z.object({
          enabled: z.boolean(),
          results: z.array(IntegrationCatalogResultSchema),
        }),
      ),
    install: oc
      .input(
        z.object({
          kind: z.enum(["skill", "plugin", "mcp", "api", "graphql"]),
          name: z.string().min(1).max(120),
          source: z.string().min(1).max(2048),
          config: z.record(z.string(), z.unknown()).default({}),
          credential: z.string().max(16_384).optional(),
          /** Required for plugins: confirms the exact previewed package content. */
          pluginDigest: z
            .string()
            .regex(/^sha256:[a-f0-9]{64}$/)
            .optional(),
          /** Plugins only: which parts to add; all supported parts when omitted. */
          pluginParts: z.array(PluginPartSchema).min(1).max(2).optional(),
        }),
      )
      .output(CapabilityInstallSchema),
    /** Add or remove parts of an installed plugin at its pinned version; no parts removes it. */
    pluginParts: oc
      .input(z.object({ id: Id, parts: z.array(PluginPartSchema).max(2) }))
      .output(z.object({ install: CapabilityInstallSchema.nullable() })),
    /** Fetch and parse a plugin repo without installing: shows the skills,
     * MCP endpoints, variables, and skipped parts before confirmation. */
    pluginPreview: oc
      .input(z.object({ source: z.string().min(1).max(2048) }))
      .output(PluginPreviewSchema),
    remove: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
  },
  mcp: {
    servers: {
      list: oc.output(z.array(McpServerSchema)),
      create: oc.input(McpServerConfigInput).output(McpServerSchema),
      update: oc
        .input(
          z.union([
            z.object({ id: Id, config: McpServerConfigInput }),
            z.object({ id: Id, secret: z.string().min(1).max(16384) }),
          ]),
        )
        .output(McpServerSchema),
      remove: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
      /** Launch the server once (installing a stdio package if needed), list its tools, close it. */
      test: oc.input(z.object({ id: Id })).output(McpServerSchema),
      /** Which agents can use the server: all of them, or only `botIds`. */
      agents: oc
        .input(z.object({ id: Id, allBots: z.boolean(), botIds: z.array(Id).max(500).default([]) }))
        .output(z.object({ server: McpServerSchema, assignments: z.array(BotMcpServerSchema) })),
    },
    assignments: {
      list: oc.input(botId).output(z.array(BotMcpServerSchema)),
      all: oc.output(z.array(BotMcpServerSchema)),
      approve: oc
        .input(z.object({ botId: Id, serverId: Id, threadId: Id.optional() }))
        .output(BotMcpServerSchema),
      dismiss: oc
        .input(z.object({ botId: Id, serverId: Id, threadId: Id.optional() }))
        .output(z.object({ ok: z.literal(true) })),
      replace: oc
        .input(
          z.object({
            botId: Id,
            assignments: z.array(
              z.object({
                serverId: Id,
                allowAllTools: z.boolean().default(true),
                allowedTools: z.array(z.string().min(1).max(200)).max(500).default([]),
              }),
            ),
          }),
        )
        .output(z.array(BotMcpServerSchema)),
    },
    oauth: {
      begin: oc.input(z.object({ serverId: Id, redirectUri: z.string().url().optional() })).output(
        z.discriminatedUnion("status", [
          z.object({
            status: z.literal("authorization_required"),
            sessionId: Id,
            authorizationUrl: z.string().url(),
          }),
          z.object({
            status: z.enum(["already_connected", "authorization_not_requested"]),
          }),
        ]),
      ),
      complete: oc
        .input(z.object({ sessionId: Id, code: z.string().min(1), state: z.string().min(1) }))
        .output(z.object({ ok: z.literal(true) })),
      disconnect: oc.input(z.object({ serverId: Id })).output(z.object({ ok: z.literal(true) })),
    },
  },
  onboarding: {
    /** Record the optional signup survey; an empty submission marks it skipped. */
    signupSurvey: oc.input(SignupSurveySchema).output(z.object({ ok: z.literal(true) })),
    /** Seed the first-run greeting into the bot's thread (focus card is separate). */
    start: oc.input(z.object({ botId: Id })).output(z.object({ ok: z.literal(true) })),
    /** Post the focus choice card when the thread is still idle. */
    promptFocus: oc.input(z.object({ botId: Id })).output(z.object({ ok: z.literal(true) })),
    /** Answer the focus choice; posts the app cards. Does not rename the bot. */
    choose: oc
      .input(z.object({ botId: Id, optionId: z.string() }))
      .output(z.object({ ok: z.literal(true) })),
    /** Dismiss the unanswered focus card without choosing an option. */
    dismissFocus: oc.input(z.object({ botId: Id })).output(z.object({ ok: z.literal(true) })),
    /** Flip an app_connect card to connected after authorization completes. */
    appConnected: oc
      .input(
        z.object({
          botId: Id,
          threadId: Id.optional(),
          /** The card's own message, so it is found however far back it is. */
          messageId: Id.optional(),
          provider: z.string(),
          connectorId: z.string().default("composio"),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
  },
  integrationSetup: {
    get: oc.output(IntegrationSetupStateSchema),
    save: oc.input(IntegrationProviderConfigSchema).output(z.object({ ok: z.literal(true) })),
  },
  connections: {
    catalog: oc
      .input(z.object({ query: z.string().optional(), connectorId: z.string().optional() }))
      .output(z.array(ConnectionCatalogItemSchema)),
    list: oc.output(z.array(ConnectionSchema)),
    begin: oc
      .input(
        z.object({
          connectorId: z.string().default("composio"),
          provider: z.string(),
          displayName: z.string(),
        }),
      )
      .output(z.object({ connectionId: Id, authorizationUrl: z.string().nullable() })),
    complete: oc
      .input(z.object({ connectionId: Id, code: z.string().optional() }))
      .output(ConnectionSchema),
    rename: oc
      .input(
        z.object({
          connectionId: Id,
          displayName: z.string().trim().min(1).max(CONNECTION_LABEL_MAX_LENGTH),
        }),
      )
      .output(ConnectionSchema),
    revoke: oc.input(z.object({ connectionId: Id })).output(z.object({ ok: z.literal(true) })),
    /** Tools the connected provider exposes. Read-only; no per-tool allowlist yet. */
    tools: oc.input(z.object({ connectorId: z.string(), provider: z.string() })).output(
      z.array(
        z.object({
          name: z.string(),
          description: z.string(),
        }),
      ),
    ),
  },
  /** External messaging surface: link state, group channels, agent connections. */
  messaging: {
    installations: {
      list: oc.output(MessagingInstallationsStatusSchema),
      /** Without a bot, the workspace answers as the first bot in the user's default space. */
      start: oc.input(z.object({ botId: Id.optional() })).output(z.object({ url: z.string() })),
      complete: oc
        .input(z.object({ state: z.string().max(64), code: z.string().max(4096) }))
        .output(z.object({ ok: z.literal(true) })),
      remove: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
    },
    status: oc.output(MessagingStatusSchema),
    link: {
      /** Issue a short-lived code the user sends to the line from a chat app. */
      start: oc.input(z.object({ botId: Id })).output(
        z.object({
          code: z.string(),
          expiresAt: z.string(),
          /** Others share the bot's Space, so they can read the chats this link brings in. */
          shared: z.boolean().optional(),
        }),
      ),
    },
    identities: {
      setBot: oc
        .input(z.object({ identityId: Id, botId: Id }))
        .output(MessagingLinkedIdentitySchema),
      unlink: oc.input(z.object({ identityId: Id })).output(z.object({ ok: z.literal(true) })),
    },
    channels: {
      list: oc.output(z.array(MessagingChannelMembershipSchema)),
      // Addressed by membership, not channel: one user can have two linked
      // chat apps in the same group, and each answers for its own agent.
      respond: oc
        .input(z.object({ membershipId: Id, accept: z.boolean() }))
        .output(MessagingChannelMembershipSchema),
      leave: oc.input(z.object({ membershipId: Id })).output(z.object({ ok: z.literal(true) })),
    },
    connections: {
      list: oc.output(z.array(MessagingAgentConnectionSchema)),
      respond: oc
        .input(z.object({ connectionId: Id, accept: z.boolean() }))
        .output(MessagingAgentConnectionSchema),
      revoke: oc.input(z.object({ connectionId: Id })).output(z.object({ ok: z.literal(true) })),
    },
  },
  approvalRules: {
    list: oc.input(settingsScopeInput.optional()).output(z.array(ActionApprovalRuleSchema)),
    set: oc
      .input(
        settingsScopeInput.extend({
          effect: z.enum(["always_allow", "require_approval", "deny"]),
          matchKind: z.enum(["tool", "connector", "site"]),
          matchValue: z.string().trim().min(1),
        }),
      )
      .output(ActionApprovalRuleSchema),
    remove: oc
      .input(settingsScopeInput.extend({ id: Id }))
      .output(z.object({ ok: z.literal(true) })),
  },
  /**
   * Sites the signed-in user opens from chat links without the external-link prompt, in every
   * space. The server computes each site from a link; bot fetches never read this list.
   */
  trustedLinkSites: {
    list: oc.output(z.array(z.string())),
    trust: oc
      .input(z.object({ url: z.string().min(1).max(8192) }))
      .output(z.object({ site: z.string() })),
    remove: oc
      .input(z.object({ site: z.string().min(1).max(253) }))
      .output(z.object({ ok: z.literal(true) })),
  },
  autoReview: {
    get: oc.input(settingsScopeInput.optional()).output(ActionAutoReviewSettingsSchema),
    set: oc
      .input(
        settingsScopeInput.extend({
          mode: ApprovalModeSchema.optional(),
          enabled: z.boolean().optional(),
          skipApprovals: z.boolean().optional(),
        }),
      )
      .output(ActionAutoReviewSettingsSchema),
  },
  /** Which account settings the bound Space overrides for the member. */
  spaceSettings: {
    overrides: oc.output(z.array(SpaceSettingSchema)),
    /** Customizing copies the account's settings into the Space; ending it drops the copy. */
    setOverride: oc
      .input(z.object({ setting: SpaceSettingSchema, enabled: z.boolean() }))
      .output(z.array(SpaceSettingSchema)),
  },
  artifacts: {
    list: oc.input(botId).output(z.array(ArtifactSchema)),
    listSpace: oc
      .input(
        z.object({
          botId: Id.optional(),
          /** Only files bots attached, leaving out uploads. */
          madeByBots: z.boolean().optional(),
          cursor: z.string().optional(),
          limit: z.number().int().min(1).max(60).optional(),
        }),
      )
      .output(
        z.object({
          items: z.array(ArtifactSchema.extend({ versionCount: z.number().int() })),
          nextCursor: z.string().nullable(),
        }),
      ),
    listVersions: oc.input(z.object({ familyId: Id })).output(z.array(ArtifactVersionSchema)),
    create: oc
      .input(
        threadTarget.and(
          z.object({
            name: z.string().min(1).max(ARTIFACT_NAME_MAX_LENGTH),
            description: z.string().max(ARTIFACT_DESCRIPTION_MAX_LENGTH).optional(),
            mimeType: z.string().min(1),
            contentBase64: z.string().min(1),
            /** Unique per upload; a retry with the same nonce returns the artifact it created. */
            clientNonce: z.string().min(1).max(200).optional(),
          }),
        ),
      )
      .output(ArtifactSchema),
    get: oc.input(threadTarget.and(z.object({ artifactId: Id }))).output(ArtifactWithContentSchema),
    getById: oc.input(z.object({ artifactId: Id })).output(ArtifactWithContentSchema),
    remove: oc.input(z.object({ artifactId: Id })).output(z.object({ ok: z.literal(true) })),
  },
  /** Pages bots built for the caller in this Space. */
  pages: {
    /** Pinned first, then most recently updated. */
    list: oc
      .input(
        z.strictObject({
          botId: Id.optional(),
          groupId: Id.optional(),
          cursor: z.string().max(500).optional(),
          limit: z.number().int().min(1).max(PAGE_LIST_MAX_LIMIT).optional(),
          /** Titles containing this text, for the command palette. */
          query: z.string().trim().min(1).max(200).optional(),
        }),
      )
      .output(
        z.strictObject({ items: z.array(PageSummarySchema), nextCursor: z.string().nullable() }),
      ),
    /** `link` also reads the page's share link, which only the share controls need. */
    get: oc
      .input(
        z.strictObject({
          pageId: Id,
          version: z.number().int().positive().optional(),
          link: z.boolean().optional(),
        }),
      )
      .output(PageDetailSchema),
    rename: oc
      .input(z.strictObject({ pageId: Id, title: PageTitleSchema }))
      .output(PageSummarySchema),
    /**
     * Turning the link on returns the page's live link, or a new one when it has none it can
     * read; turning it off breaks the old link, so the next turn-on issues a new one.
     */
    setVisibility: oc
      .input(z.strictObject({ pageId: Id, visibility: PageVisibilitySchema }))
      .output(
        z.strictObject({ visibility: PageVisibilitySchema, shareUrl: z.string().nullable() }),
      ),
    pin: oc.input(z.strictObject({ pageId: Id, pinned: z.boolean() })).output(PageSummarySchema),
    remove: oc.input(z.strictObject({ pageId: Id })).output(z.object({ ok: z.literal(true) })),
  },
  usage: {
    list: oc.output(z.array(UsageRecordSchema)),
    summary: oc.output(UsageSummarySchema),
    /** Subscription sign-ins whose allowance could be read; others are left out. */
    limits: oc.output(z.array(PlanLimitsSchema)),
  },
  export: {
    bot: oc.input(botId).output(ExportManifestSchema),
    /**
     * A one-time token for `GET /api/account/export?token=`, which streams the account zip. Needs
     * a recent identity confirmation on this session (IDENTITY_CONFIRMATION_REQUIRED).
     */
    accountToken: oc.output(z.object({ token: z.string() })),
  },
  notifications: {
    /**
     * Run alerts for the signed-in user's chats in this space, live while connected. `roster`
     * says `spaces.list` may have changed.
     */
    subscribe: oc.output(
      eventIterator(
        z.object({
          type: z.enum(["alert", "roster", "heartbeat"]),
          alert: ChatAlertSchema.optional(),
        }),
      ),
    ),
    subscribeCalls: oc.output(
      eventIterator(
        z.object({
          type: z.enum(["incoming.calls", "heartbeat"]),
          payload: z.object({ calls: z.array(IncomingBotCallSchema) }).optional(),
        }),
      ),
    ),
    declineIncomingCall: oc
      .input(z.object({ callId: z.string().uuid() }))
      .output(z.object({ ok: z.literal(true) })),
    registerCallPush: oc
      .input(
        z
          .object({
            deviceId: z.string().uuid(),
            platform: z.enum(["ios", "android"]),
            expoToken: z.string().min(8).max(512).regex(/^\S+$/).optional(),
            voipToken: z
              .string()
              .regex(/^[a-fA-F0-9]{64,200}$/)
              .optional(),
          })
          .refine((value) =>
            Boolean(value.expoToken || (value.platform === "ios" && value.voipToken)),
          ),
      )
      .output(z.object({ ok: z.literal(true) })),
    registerPush: oc
      // No whitespace: the token store keeps the registering session on the next line.
      .input(
        z.object({
          token: z.string().min(8).max(512).regex(/^\S+$/),
          presentation: z.literal("android_sender").optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    unregisterPush: oc.output(z.object({ ok: z.literal(true) })),
    /**
     * Keeps this phone's live status card of the user's bots at work up to date. `following` is
     * false when the server cannot update the card or no bot is at work, so the app ends it.
     * Omit `token` to check server support before creating a card; this does not follow work.
     */
    followWorkActivity: oc
      .input(
        z.object({
          token: z
            .string()
            .regex(/^[a-fA-F0-9]{64,512}$/)
            .optional(),
        }),
      )
      .output(z.object({ following: z.boolean() })),
    /**
     * Lets the server start this phone's live status card when the user's bots get to work from
     * another device. `token` is the phone's token for starting cards, again whenever it changes.
     */
    registerWorkActivityStarts: oc
      .input(z.object({ token: z.string().regex(/^[a-fA-F0-9]{64,512}$/) }))
      .output(z.object({ ok: z.literal(true) })),
  },
  search: {
    query: oc.input(z.object({ q: z.string().max(200) })).output(SearchQueryOutputSchema),
  },
  links: {
    /**
     * The site icon for a link's origin as a small data URL, resolved and cached by the server.
     * `retry` means the server was too busy to look; the origin may still have an icon.
     */
    favicon: oc
      // The longest origin: a scheme, a 253-character host name and a port.
      .input(z.object({ origin: z.string().max("https://".length + 253 + ":65535".length) }))
      .output(z.object({ icon: z.string().nullable(), retry: z.boolean().optional() })),
  },
  runs: {
    list: oc.input(z.object({ filter: z.enum(["active", "recent"]) })).output(RunsListOutputSchema),
  },
  /** The account's spending limit for payments its bots make. */
  spendingLimit: {
    get: oc.output(SpendingStatusSchema),
    /** `null` removes the limit. */
    set: oc
      .input(z.object({ limit: SpendingLimitSchema.nullable() }).strict())
      .output(SpendingStatusSchema),
    /** The latest payments that count, newest first. */
    payments: oc.output(z.array(SpendingPaymentSchema)),
  },
  /** The signed-in user's wallet; absent when the deployment offers none. */
  paymentWallet: {
    status: oc.output(PaymentWalletStatusSchema),
    /** Starts a sign-in the user finishes with the provider; `status` then reports it. */
    connect: oc.output(PaymentWalletStatusSchema),
    disconnect: oc.output(PaymentWalletStatusSchema),
  },
  voice: {
    catalog: oc.output(z.array(VoiceCatalogEntrySchema)),
    status: oc.input(settingsScopeInput.optional()).output(VoiceStatusSchema),
    credentials: oc.input(settingsScopeInput.optional()).output(z.array(VoiceCredentialSchema)),
    connect: oc
      .input(
        z
          .object({
            provider: z.string(),
            /**
             * Optional for a self-hosted server, for providers without keys, and for a provider
             * the account's model connection authenticates (the catalog's `modelConnection`).
             */
            apiKey: z.string().max(4096).default(""),
            voiceId: z.string().max(120).optional(),
            speechModel: z.string().max(64).optional(),
            /** Self-hosted (OpenAI-compatible) server address and model ids. */
            baseUrl: z.string().max(2048).optional(),
            ttsModel: z.string().max(200).optional(),
            sttModel: z.string().max(200).optional(),
            /** Where the connection becomes the default voice. */
            scope: SettingsScopeSchema.optional(),
          })
          .superRefine((input, ctx) => {
            // Hosted keys are checked by the server, which knows which providers are keyless.
            if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID && !input.baseUrl?.trim()) {
              ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "Enter a server URL." });
            }
          }),
      )
      .output(VoiceCredentialSchema),
    disconnect: oc
      .input(z.object({ provider: z.string().min(1) }))
      .output(z.object({ ok: z.literal(true) })),
    setVoice: oc
      .input(
        settingsScopeInput.extend({
          voiceId: z.string().min(1).max(120),
          provider: z.string().optional(),
        }),
      )
      .output(VoiceStatusSchema),
    setSpeechModel: oc
      .input(
        settingsScopeInput.extend({
          provider: z.string().min(1),
          speechModel: z.string().max(64),
        }),
      )
      .output(VoiceCredentialSchema),
    voices: oc
      .input(
        settingsScopeInput.extend({
          provider: z.string().optional(),
          /** BCP-47 tag or ISO 639-1 code; providers narrow it to what they support. */
          language: z.string().max(35).optional(),
        }),
      )
      .output(z.array(VoiceInfoSchema)),
    prepare: oc
      .input(
        z.object({
          text: z.string().max(20000),
          voiceId: z.string().max(120).optional(),
          botId: Id.optional(),
          scope: SettingsScopeSchema.optional(),
        }),
      )
      .output(z.object({ ready: z.boolean(), utterances: z.array(z.string()) })),
  },
  externalConversations: {
    updatePolicy: oc
      .input(UpdateExternalConversationPolicyInput)
      .output(ExternalConversationPolicySchema),
  },
  agentSecrets: {
    list: oc.output(z.array(AgentSecretSchema)),
    put: oc.input(AgentSecretInputSchema).output(AgentSecretSchema),
    remove: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
  },
  vault: {
    list: oc.input(settingsScopeInput.optional()).output(z.array(BotSecretMetadata)),
    put: oc.input(VaultPutInput).output(BotSecretMetadata),
    /** Needs a recent identity confirmation on this session (IDENTITY_CONFIRMATION_REQUIRED). */
    reveal: oc.input(VaultRevealInput).output(VaultRevealed),
    import: oc.input(VaultImportInput).output(VaultImportResult),
    activity: oc
      .input(settingsScopeInput.extend({ name: StoredBotSecretName }))
      .output(z.array(VaultUse).max(VAULT_ACTIVITY_LIMIT)),
    remove: oc
      .input(settingsScopeInput.extend({ name: StoredBotSecretName }))
      .output(z.object({ ok: z.literal(true) })),
  },
  /** The vault this Space uses, for apps that predate it. The bot only checks access. */
  botSecrets: {
    list: oc.input(z.object({ botId: Id })).output(z.array(BotSecretMetadata)),
    put: oc.input(BotSecretPutInput).output(BotSecretMetadata),
    remove: oc
      .input(z.object({ botId: Id, name: StoredBotSecretName }))
      .output(z.object({ ok: z.literal(true) })),
  },
};

export type AppContract = typeof appContract;

type ProcedurePaths<Router, Prefix extends string = ""> = {
  [Key in keyof Router & string]: Router[Key] extends AnyContractProcedure
    ? `${Prefix}${Key}`
    : ProcedurePaths<Router[Key], `${Prefix}${Key}/`>;
}[keyof Router & string];

type AtPath<Tree, Path extends string> = Path extends `${infer Head}/${infer Rest}`
  ? Head extends keyof Tree
    ? AtPath<Tree[Head], Rest>
    : never
  : Path extends keyof Tree
    ? Tree[Path]
    : never;

/** A procedure's URL path under `/rpc/`, such as `bots/list`. */
export type RpcPath = ProcedurePaths<AppContract>;
type RpcInputs = { [Path in RpcPath]: AtPath<InferContractRouterInputs<AppContract>, Path> };
type RpcOutputs = { [Path in RpcPath]: AtPath<InferContractRouterOutputs<AppContract>, Path> };
export type RpcInput<Path extends RpcPath> = RpcInputs[Path];
export type RpcOutput<Path extends RpcPath> = RpcOutputs[Path];
