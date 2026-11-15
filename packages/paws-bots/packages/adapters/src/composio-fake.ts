import type {
  ConnectedAccountListParams,
  ConnectedAccountListResponse,
  ConnectedAccountRetrieveResponse,
  ConnectedAccountStatus,
  ConnectionRequest,
  ToolRouterCreateSessionConfig,
  ToolRouterToolkitsOptions,
} from "@composio/core";
import type { ToolkitDirectoryEntry } from "./composio-catalog-cache.js";
import type { ComposioClient, ComposioSession } from "./composio-connector.js";
import { collectPages } from "./connector-catalog.js";
import type { EmulatedGithubRelease } from "./release-watch.js";
import {
  DEFAULT_RAKAZO_EMULATED_RELEASES,
  RELEASE_WATCH_GITHUB_TOOL_NAMES,
} from "./release-watch.js";

type SessionTools = Awaited<ReturnType<ComposioSession["tools"]>>;
type ToolkitPage = Awaited<ReturnType<ComposioSession["toolkits"]>>;
type DeleteResponse = Awaited<ReturnType<ComposioClient["connectedAccounts"]["delete"]>>;

const DEFAULT_DIRECTORY: readonly ToolkitDirectoryEntry[] = [
  { slug: "GMAIL", name: "Gmail", logo: null, noAuth: false },
  { slug: "GOOGLECALENDAR", name: "Google Calendar", logo: null, noAuth: false },
  { slug: "GOOGLEDRIVE", name: "Google Drive", logo: null, noAuth: false },
  { slug: "SLACK", name: "Slack", logo: null, noAuth: false },
  { slug: "GITHUB", name: "GitHub", logo: null, noAuth: false },
  { slug: "NOTION", name: "Notion", logo: null, noAuth: false },
];

type FakeAccount = {
  id: string;
  userId: string;
  /** Composio reports toolkit slugs in lower case on connected accounts. */
  toolkit: string;
  status: ConnectedAccountStatus;
};

type MailMessage = {
  messageId: string;
  threadId: string;
  subject: string;
  sender: string;
  to: string;
  snippet: string;
  messageText: string;
  labelIds: string[];
  internalDate: string;
};

type MailDraft = {
  draftId: string;
  messageId: string;
  threadId: string;
  recipientEmail: string;
  subject: string;
  body: string;
};

type Mailbox = {
  messages: MailMessage[];
  drafts: MailDraft[];
  nextMessageSeq: number;
  nextDraftSeq: number;
};

type ToolResult = { data: Record<string, unknown>; error: string | null };

const SYSTEM_LABELS = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "UNREAD", name: "UNREAD", type: "system" },
  { id: "SENT", name: "SENT", type: "system" },
  { id: "DRAFT", name: "DRAFT", type: "system" },
  { id: "STARRED", name: "STARRED", type: "system" },
  { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
  { id: "SPAM", name: "SPAM", type: "system" },
  { id: "TRASH", name: "TRASH", type: "system" },
] as const;

function functionTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): SessionTools[number] {
  return { type: "function", function: { name, description, parameters } };
}

const GMAIL_TOOLS: SessionTools = [
  functionTool("GMAIL_FETCH_EMAILS", "Fetch email messages from the connected Gmail mailbox", {
    type: "object",
    properties: {
      query: { type: "string", description: "Gmail search query" },
      max_results: {
        type: "integer",
        description: "Maximum number of messages to return",
        minimum: 1,
        maximum: 500,
      },
      label_ids: {
        type: "array",
        items: { type: "string" },
        description: "Label IDs that messages must include",
      },
      include_spam_trash: { type: "boolean" },
      ids_only: { type: "boolean" },
    },
  }),
  functionTool("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", "Fetch a single Gmail message by message id", {
    type: "object",
    properties: {
      message_id: { type: "string", description: "Gmail message id" },
      format: { type: "string", enum: ["minimal", "metadata", "full", "raw"] },
    },
    required: ["message_id"],
  }),
  functionTool("GMAIL_FETCH_MESSAGE_BY_THREAD_ID", "Fetch messages belonging to a Gmail thread", {
    type: "object",
    properties: { thread_id: { type: "string", description: "Gmail thread id" } },
    required: ["thread_id"],
  }),
  functionTool("GMAIL_SEND_EMAIL", "Send an email through the connected Gmail account", {
    type: "object",
    properties: {
      recipient_email: { type: "string", description: "Primary recipient" },
      to: { type: "string", description: "Alias for recipient_email" },
      subject: { type: "string" },
      body: { type: "string" },
      cc: { type: "array", items: { type: "string" } },
      bcc: { type: "array", items: { type: "string" } },
      is_html: { type: "boolean" },
    },
    required: ["subject"],
  }),
  functionTool(
    "GMAIL_CREATE_EMAIL_DRAFT",
    "Create a Gmail draft, optionally as a reply in a thread",
    {
      type: "object",
      properties: {
        recipient_email: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
        thread_id: { type: "string", description: "Existing thread to draft a reply in" },
        is_html: { type: "boolean" },
      },
    },
  ),
  functionTool("GMAIL_LIST_LABELS", "List system and user labels for the connected Gmail account", {
    type: "object",
    properties: { include_details: { type: "boolean" } },
  }),
];

const GITHUB_TOOLS: SessionTools = [
  functionTool(
    "GITHUB_LIST_RELEASES",
    "List releases for a GitHub repository (owner + repo). Prefer this over browsing github.com or web search when GitHub is connected.",
    {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner, e.g. elie222" },
        repo: { type: "string", description: "Repository name, e.g. rakazo" },
      },
      required: ["owner", "repo"],
    },
  ),
  functionTool(
    "GITHUB_GET_RELEASE",
    "Get one GitHub release by tag for owner/repo, or the latest release when tag is omitted. Prefer this over a computer browser.",
    {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        tag: { type: "string", description: "Release tag; omit for latest." },
      },
      required: ["owner", "repo"],
    },
  ),
];

function toolsFor(toolkit: string): SessionTools {
  if (toolkit === "GMAIL") return GMAIL_TOOLS;
  if (toolkit === "GITHUB") return GITHUB_TOOLS;
  return [
    functionTool(`${toolkit}_EMULATED_ACTION`, `Run a deterministic ${toolkit} action`, {
      type: "object",
      properties: { value: { type: "string" } },
    }),
  ];
}

function notFound(message: string): Error {
  return Object.assign(new Error(message), { status: 404 });
}

/**
 * Deterministic, offline stand-in for the Composio SDK client. It keeps
 * connected accounts with real statuses and cursor pagination, tool-router
 * sessions, and a small Gmail and GitHub backend so product tests run the real
 * `ComposioConnector`.
 */
export class FakeComposioClient implements ComposioClient {
  readonly accounts: FakeAccount[] = [];
  readonly created: Array<{ userId: string; config: ToolRouterCreateSessionConfig }> = [];
  readonly accountListCalls: ConnectedAccountListParams[] = [];
  readonly executions: Array<{
    userId: string;
    tool: string;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }> = [];
  /** When set, connected-account listing fails like an API outage. */
  failAccountList = false;
  private readonly sessionsById = new Map<string, ComposioSession>();
  private readonly mailboxesByUser = new Map<string, Mailbox>();
  private githubReleases: EmulatedGithubRelease[] = [...DEFAULT_RAKAZO_EMULATED_RELEASES];
  private nextId = 0;

  constructor(private readonly directory: readonly ToolkitDirectoryEntry[] = DEFAULT_DIRECTORY) {}

  readonly sessions = {
    use: async (sessionId: string): Promise<ComposioSession> => {
      const session = this.sessionsById.get(sessionId);
      if (!session) throw notFound(`Session ${sessionId} not found`);
      return session;
    },
  };

  getClient(): ReturnType<ComposioClient["getClient"]> {
    return {
      tools: {
        list: async (query) => {
          const tools = toolsFor(query.toolkit_slug.toUpperCase());
          const offset = Number(query.cursor ?? 0);
          const end = offset + query.limit;
          return {
            items: tools.slice(offset, end),
            next_cursor: end < tools.length ? String(end) : null,
          };
        },
      },
    };
  }

  readonly connectedAccounts: ComposioClient["connectedAccounts"] = {
    list: async (query?: ConnectedAccountListParams): Promise<ConnectedAccountListResponse> => {
      this.accountListCalls.push(query ?? {});
      if (this.failAccountList) throw new Error("connected account listing unavailable");
      const toolkits = query?.toolkitSlugs?.map((slug) => slug.toLowerCase());
      const matches = this.accounts.filter(
        (account) =>
          (!query?.userIds || query.userIds.includes(account.userId)) &&
          (!query?.statuses || query.statuses.includes(account.status)) &&
          (!toolkits || toolkits.includes(account.toolkit)),
      );
      // One account per page unless asked otherwise, so callers must follow nextCursor.
      const limit = query?.limit ?? 1;
      const start = Number(query?.cursor ?? 0);
      const end = start + limit;
      return {
        items: matches.slice(start, end).map((account) => this.toResponse(account)),
        totalPages: Math.max(1, Math.ceil(matches.length / limit)),
        nextCursor: end < matches.length ? String(end) : null,
      };
    },
    waitForConnection: async (id: string): Promise<ConnectedAccountRetrieveResponse> => {
      const account = this.accounts.find((candidate) => candidate.id === id);
      if (!account) throw notFound(`Connected account ${id} not found`);
      if (account.status !== "ACTIVE") {
        throw new Error(`Connected account ${id} is ${account.status}`);
      }
      return this.toResponse(account);
    },
    delete: async (id: string): Promise<DeleteResponse> => {
      const index = this.accounts.findIndex((account) => account.id === id);
      if (index < 0) throw notFound(`Connected account ${id} not found`);
      const [removed] = this.accounts.splice(index, 1);
      // The mailbox belongs to the user's Gmail; drop it with their last account.
      if (
        removed?.toolkit === "gmail" &&
        !this.accounts.some((a) => a.userId === removed.userId && a.toolkit === "gmail")
      ) {
        this.mailboxesByUser.delete(removed.userId);
      }
      return { success: true };
    },
  };

  readonly toolkits: ComposioClient["toolkits"] = {
    get: async () =>
      this.directory.map((entry) => ({
        slug: entry.slug,
        noAuth: entry.noAuth,
        composioManagedAuthSchemes: entry.needsSignInSetup || entry.noAuth ? [] : ["OAUTH2"],
      })),
  };

  readonly authConfigs: ComposioClient["authConfigs"] = {
    list: async () => ({ items: [], nextCursor: null }),
  };

  async create(userId: string, config: ToolRouterCreateSessionConfig): Promise<ComposioSession> {
    this.created.push({ userId, config });
    const toolkits = Array.isArray(config.toolkits) ? config.toolkits : [];
    // Composio rejects the whole session when a pinned account is not usable.
    for (const ids of Object.values(config.connectedAccounts ?? {})) {
      for (const id of ids) {
        const account = this.accounts.find((candidate) => candidate.id === id);
        if (account?.userId !== userId || account.status !== "ACTIVE") {
          throw new Error(`Connected account ${id} is not active`);
        }
      }
    }
    const sessionId = `session_${++this.nextId}`;
    const enabled = new Set(toolkits.map((slug) => slug.toUpperCase()));
    const session: ComposioSession = {
      sessionId,
      toolkits: async (options) => this.toolkitPage(userId, options),
      tools: async () => [...enabled].flatMap((toolkit) => toolsFor(toolkit)),
      execute: async (tool, args = {}, options) => {
        const refused = (error: string) => ({
          data: {},
          error,
          logId: "",
          resultType: "failed" as const,
        });
        const toolkit = [...enabled].find((slug) => tool.startsWith(`${slug}_`));
        if (!toolkit && !tool.startsWith("COMPOSIO_")) {
          return refused(`Toolkit for ${tool} is not enabled in this session`);
        }
        const pinned = toolkit ? (config.connectedAccounts?.[toolkit] ?? []) : [];
        if (options?.account && !pinned.includes(options.account)) {
          return refused(`Account ${options.account} is not available in this session`);
        }
        if (
          !options?.account &&
          pinned.length > 1 &&
          config.multiAccount?.requireExplicitSelection
        ) {
          return refused(`Select which ${toolkit} account to use`);
        }
        const result = this.run(userId, tool, args);
        this.executions.push({ userId, tool, args, result: result.data });
        return {
          ...result,
          logId: `log_${++this.nextId}`,
          resultType: result.error ? ("failed" as const) : ("completed" as const),
        };
      },
      authorize: async (toolkit) => this.authorize(userId, toolkit),
    };
    this.sessionsById.set(sessionId, session);
    return session;
  }

  /** Add a connected account directly, as if the user finished OAuth elsewhere. */
  connect(userId: string, toolkit: string, status: ConnectedAccountStatus = "ACTIVE"): string {
    const id = `ca_${++this.nextId}`;
    this.accounts.push({ id, userId, toolkit: toolkit.toLowerCase(), status });
    if (toolkit.toUpperCase() === "GMAIL") this.ensureMailbox(userId);
    return id;
  }

  setStatus(id: string, status: ConnectedAccountStatus): void {
    const account = this.accounts.find((candidate) => candidate.id === id);
    if (!account) throw notFound(`Connected account ${id} not found`);
    account.status = status;
  }

  mailboxFor(userId: string): Mailbox | undefined {
    return this.mailboxesByUser.get(userId);
  }

  seedGithubReleases(releases: readonly EmulatedGithubRelease[]): void {
    this.githubReleases = [...releases];
  }

  listGithubReleases(): readonly EmulatedGithubRelease[] {
    return this.githubReleases;
  }

  private async authorize(userId: string, slug: string): Promise<ConnectionRequest> {
    const toolkit = this.directory.find((entry) => entry.slug.toLowerCase() === slug.toLowerCase());
    if (!toolkit) throw notFound(`Toolkit ${slug} not found`);
    if (toolkit.noAuth)
      throw new Error(`ToolkitsIsNoAuth: ${toolkit.slug} does not require authentication`);
    if (toolkit.needsSignInSetup) {
      const items = await collectPages(async (cursor) => {
        const page = await this.authConfigs.list({ cursor });
        return { items: page.items, cursor: page.nextCursor ?? undefined };
      });
      const configured = items.some(
        (config) =>
          config.status === "ENABLED" && config.toolkit.slug.toLowerCase() === slug.toLowerCase(),
      );
      if (!configured) throw new Error(`ToolRouterV2_NoManagedAuth: no auth for ${toolkit.slug}`);
    }
    // Connects instantly, the way an API-key or already-consented toolkit does.
    const id = this.connect(userId, toolkit.slug);
    const state = { id, status: "ACTIVE" as const, redirectUrl: null };
    return {
      ...state,
      waitForConnection: () => this.connectedAccounts.waitForConnection(id),
      toJSON: () => state,
      toString: () => JSON.stringify(state),
    };
  }

  private toolkitPage(userId: string, options: ToolRouterToolkitsOptions = {}): ToolkitPage {
    const search = options.search?.trim().toLowerCase();
    const wanted = options.toolkits?.map((slug) => slug.toLowerCase());
    const items = this.directory
      .map((entry) => {
        const accounts = this.accounts.filter(
          (account) => account.userId === userId && account.toolkit === entry.slug.toLowerCase(),
        );
        const account = accounts.find((a) => a.status === "ACTIVE") ?? accounts.at(-1);
        return {
          slug: entry.slug,
          name: entry.name,
          isNoAuth: entry.noAuth,
          ...(entry.logo ? { logo: entry.logo } : {}),
          ...(account
            ? {
                connection: {
                  isActive: account.status === "ACTIVE",
                  connectedAccount: { id: account.id, status: account.status },
                },
              }
            : {}),
        };
      })
      .filter(
        (item) =>
          (!options.isConnected || item.connection || item.isNoAuth) &&
          (!wanted || wanted.includes(item.slug.toLowerCase())) &&
          (!search ||
            item.slug.toLowerCase().includes(search) ||
            item.name.toLowerCase().includes(search)),
      );
    const limit = options.limit ?? 20;
    const start = Number(options.cursor ?? 0);
    const end = start + limit;
    return {
      items: items.slice(start, end),
      cursor: end < items.length ? String(end) : undefined,
      totalPages: Math.max(1, Math.ceil(items.length / limit)),
    };
  }

  private toResponse(account: FakeAccount): ConnectedAccountRetrieveResponse {
    return {
      id: account.id,
      authConfig: { id: `ac_${account.toolkit}`, isComposioManaged: true, isDisabled: false },
      status: account.status,
      statusReason: null,
      toolkit: { slug: account.toolkit },
      isDisabled: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  private run(userId: string, tool: string, args: Record<string, unknown>): ToolResult {
    if (tool.startsWith("GMAIL_")) return this.runGmail(tool, args, userId);
    if ((RELEASE_WATCH_GITHUB_TOOL_NAMES as readonly string[]).includes(tool)) {
      return { data: this.runGithub(tool, args), error: null };
    }
    return { data: { ok: true, tool, args }, error: null };
  }

  private runGithub(tool: string, args: Record<string, unknown>): Record<string, unknown> {
    const owner = String(args.owner ?? args.owner_name ?? "elie222");
    const repo = String(args.repo ?? args.repository ?? "rakazo");
    const matched = this.githubReleases.filter(
      (release) =>
        release.owner.toLowerCase() === owner.toLowerCase() &&
        release.repo.toLowerCase() === repo.toLowerCase(),
    );
    if (tool === "GITHUB_LIST_RELEASES") {
      return {
        ok: true,
        tool,
        owner,
        repo,
        releases: matched.map((release) => ({
          tag: release.tag,
          name: release.name,
          body: release.body,
          publishedAt: release.publishedAt,
          htmlUrl: release.htmlUrl,
        })),
      };
    }
    const tag = args.tag ? String(args.tag) : undefined;
    const release = tag
      ? matched.find((row) => row.tag === tag)
      : [...matched].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
    if (!release) return { ok: false, tool, error: `No release found for ${owner}/${repo}` };
    return { ok: true, tool, release };
  }

  private ensureMailbox(userId: string): Mailbox {
    const existing = this.mailboxesByUser.get(userId);
    if (existing) return existing;
    const seeded = seedMailbox();
    this.mailboxesByUser.set(userId, seeded);
    return seeded;
  }

  private runGmail(tool: string, args: Record<string, unknown>, userId: string): ToolResult {
    const mailbox = this.ensureMailbox(userId);
    switch (tool) {
      case "GMAIL_FETCH_EMAILS": {
        const query = asString(args.query);
        const maxResults = Math.min(asPositiveInt(args.max_results, 10), 500);
        const labelIds = asStringArray(args.label_ids);
        const includeSpamTrash = args.include_spam_trash === true;
        const idsOnly = args.ids_only === true;
        const messages = mailbox.messages
          .filter((message) => {
            if (
              !includeSpamTrash &&
              message.labelIds.some((id) => id === "SPAM" || id === "TRASH")
            ) {
              return false;
            }
            if (labelIds.length > 0 && !labelIds.every((id) => message.labelIds.includes(id))) {
              return false;
            }
            return matchesQuery(message, query);
          })
          .slice(0, maxResults)
          .map((message) => summarizeMessage(message, idsOnly));
        return { data: { messages, resultSizeEstimate: messages.length }, error: null };
      }
      case "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID": {
        const messageId = asString(args.message_id);
        const message = mailbox.messages.find((item) => item.messageId === messageId);
        if (!message) return { data: {}, error: `Message not found: ${messageId}` };
        return { data: fullMessage(message), error: null };
      }
      case "GMAIL_FETCH_MESSAGE_BY_THREAD_ID": {
        const threadId = asString(args.thread_id);
        const messages = mailbox.messages
          .filter((message) => message.threadId === threadId)
          .map(fullMessage);
        if (messages.length === 0) return { data: {}, error: `Thread not found: ${threadId}` };
        return { data: { messages }, error: null };
      }
      case "GMAIL_SEND_EMAIL": {
        const recipient =
          asString(args.recipient_email) ||
          asString(args.to) ||
          asStringArray(args.cc)[0] ||
          asStringArray(args.bcc)[0] ||
          "";
        const subject = asString(args.subject);
        const body = asString(args.body);
        if (!recipient) {
          return { data: {}, error: "recipient_email (or to/cc/bcc) is required" };
        }
        if (!subject && !body) return { data: {}, error: "subject or body is required" };
        const ids = nextMessageIds(mailbox);
        const message: MailMessage = {
          messageId: ids.messageId,
          threadId: ids.threadId,
          subject: subject || "(no subject)",
          sender: "me@example.test",
          to: recipient,
          snippet: body.slice(0, 120),
          messageText: body,
          labelIds: ["SENT"],
          internalDate: String(Date.UTC(2024, 5, 1, 15, 0, 0) + mailbox.nextMessageSeq * 1000),
        };
        mailbox.messages.push(message);
        return {
          data: {
            messageId: message.messageId,
            threadId: message.threadId,
            labelIds: [...message.labelIds],
          },
          error: null,
        };
      }
      case "GMAIL_CREATE_EMAIL_DRAFT": {
        const recipient = asString(args.recipient_email);
        const subject = asString(args.subject);
        const body = asString(args.body);
        const replyThreadId = asString(args.thread_id);
        const ids = nextMessageIds(mailbox);
        const threadId =
          replyThreadId && mailbox.messages.some((message) => message.threadId === replyThreadId)
            ? replyThreadId
            : ids.threadId;
        const draftId = `r${1_000_000_000 + mailbox.nextDraftSeq++}`;
        const draft: MailDraft = {
          draftId,
          messageId: ids.messageId,
          threadId,
          recipientEmail: recipient,
          subject,
          body,
        };
        mailbox.drafts.push(draft);
        mailbox.messages.push({
          messageId: draft.messageId,
          threadId: draft.threadId,
          subject: subject || "(no subject)",
          sender: "me@example.test",
          to: recipient,
          snippet: body.slice(0, 120),
          messageText: body,
          labelIds: ["DRAFT"],
          internalDate: String(Date.UTC(2024, 5, 1, 16, 0, 0) + mailbox.nextDraftSeq * 1000),
        });
        return {
          data: {
            draft_id: draft.draftId,
            id: draft.draftId,
            message: { id: draft.messageId, threadId: draft.threadId },
          },
          error: null,
        };
      }
      case "GMAIL_LIST_LABELS": {
        const includeDetails = args.include_details === true;
        const labels = SYSTEM_LABELS.map((label) => {
          if (!includeDetails) return { ...label };
          const matching = mailbox.messages.filter((message) =>
            message.labelIds.includes(label.id),
          );
          const unread = matching.filter((message) => message.labelIds.includes("UNREAD"));
          return {
            ...label,
            messagesTotal: matching.length,
            messagesUnread: unread.length,
            threadsTotal: new Set(matching.map((message) => message.threadId)).size,
            threadsUnread: new Set(unread.map((message) => message.threadId)).size,
          };
        });
        return { data: { labels }, error: null };
      }
      default:
        return { data: {}, error: `Unknown Gmail tool: ${tool}` };
    }
  }
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (parsed > 0) return parsed;
  }
  return fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function seedMailbox(): Mailbox {
  const base = Date.UTC(2024, 0, 15, 12, 0, 0);
  return {
    messages: [
      {
        messageId: "18c5f5d1a2b3c4d5",
        threadId: "18c5f5d1a2b3c4d5",
        subject: "Welcome to Rakazo",
        sender: "hello@rakazo.test",
        to: "me@example.test",
        snippet: "Your inbox is ready for agent workflows.",
        messageText: "Your inbox is ready for agent workflows.\n\n— Rakazo",
        labelIds: ["INBOX", "UNREAD"],
        internalDate: String(base),
      },
      {
        messageId: "18c5f5d1a2b3c4d6",
        threadId: "18c5f5d1a2b3c4d6",
        subject: "Quarterly planning notes",
        sender: "teammate@example.test",
        to: "me@example.test",
        snippet: "Here are the notes from Monday's planning session.",
        messageText: "Here are the notes from Monday's planning session.\n\nAction items attached.",
        labelIds: ["INBOX"],
        internalDate: String(base + 86_400_000),
      },
      {
        messageId: "18c5f5d1a2b3c4d7",
        threadId: "18c5f5d1a2b3c4d6",
        subject: "Re: Quarterly planning notes",
        sender: "me@example.test",
        to: "teammate@example.test",
        snippet: "Thanks — I'll update the timeline today.",
        messageText: "Thanks — I'll update the timeline today.",
        labelIds: ["SENT"],
        internalDate: String(base + 90_000_000),
      },
    ],
    drafts: [],
    nextMessageSeq: 1,
    nextDraftSeq: 1,
  };
}

function nextMessageIds(mailbox: Mailbox): { messageId: string; threadId: string } {
  const hex = (0x18c5f5e0 + mailbox.nextMessageSeq++).toString(16);
  return { messageId: hex, threadId: hex };
}

function matchesQuery(message: MailMessage, query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return true;
  const haystack = [
    message.subject,
    message.sender,
    message.to,
    message.snippet,
    message.messageText,
    message.labelIds.join(" "),
  ]
    .join("\n")
    .toLowerCase();
  return trimmed
    .toLowerCase()
    .split(/\s+/)
    .every((token) => {
      const labeled = token.match(/^(from|to|subject|label):(.*)$/);
      if (!labeled) return haystack.includes(token);
      const [, field, value] = labeled;
      if (!value) return true;
      if (field === "from") return message.sender.toLowerCase().includes(value);
      if (field === "to") return message.to.toLowerCase().includes(value);
      if (field === "subject") return message.subject.toLowerCase().includes(value);
      if (field === "label") return message.labelIds.some((id) => id.toLowerCase() === value);
      return haystack.includes(token);
    });
}

function summarizeMessage(message: MailMessage, idsOnly: boolean) {
  if (idsOnly) return { messageId: message.messageId, threadId: message.threadId };
  return {
    messageId: message.messageId,
    threadId: message.threadId,
    subject: message.subject,
    sender: message.sender,
    to: message.to,
    snippet: message.snippet,
    labelIds: [...message.labelIds],
    internalDate: message.internalDate,
  };
}

function fullMessage(message: MailMessage) {
  return { ...summarizeMessage(message, false), messageText: message.messageText };
}
