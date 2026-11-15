import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { ComposioConnector, FakeComposioClient } from "@rakazo/adapters";
import { CUSTOMER_SUPPORT_PROVIDERS, CUSTOMER_SUPPORT_TOOLS } from "./service-contract.js";

export const INBOX = [
  {
    id: "m1",
    subject: "Launch blocker",
    body: "The launch is blocked by the unsigned contract. Review it by Friday.",
    urgent: true,
  },
  {
    id: "m2",
    subject: "Invoice correction",
    body: "Invoice INV-42 must be corrected from 900 to 720 credits by Thursday.",
    urgent: true,
  },
  { id: "m3", subject: "Lunch club", body: "Optional lunch club meets Tuesday.", urgent: false },
];
export type ServiceCallOutcome = "read" | "write" | "uncertain-write" | "rejected";
export type ServiceCall = {
  tool: string;
  args: Record<string, unknown>;
  outcome: ServiceCallOutcome;
};

const DIRECTORY = [
  { slug: "GMAIL", name: "Gmail", logo: null, noAuth: false },
  { slug: "CRM", name: "CRM", logo: null, noAuth: false },
  { slug: "GITHUB", name: "GitHub", logo: null, noAuth: false },
  { slug: CUSTOMER_SUPPORT_PROVIDERS.salesforce, name: "Salesforce", logo: null, noAuth: false },
  { slug: CUSTOMER_SUPPORT_PROVIDERS.zendesk, name: "Zendesk", logo: null, noAuth: false },
];

/**
 * State belongs to one trial. Reads observe state; invalid actions never advance it.
 * Catalog, connections and GitHub run through the real connector over a fake Composio client.
 */
export class EvalServices extends ComposioConnector {
  private readonly composio: FakeComposioClient;
  private diagnosticChain: Array<{ cursor: string; nextCursor: string | null }> = [];
  enableDiagnosticChain(length = 12) {
    if (!Number.isSafeInteger(length) || length < 2 || length > 50)
      throw new Error("Invalid diagnostic chain length");
    this.diagnosticChain = Array.from({ length }, (_, i) => ({
      cursor: i ? `segment-${Math.imul(i + 73, 48271) >>> 0}` : "start",
      nextCursor: i + 1 < length ? `segment-${Math.imul(i + 74, 48271) >>> 0}` : null,
    }));
  }
  readonly calls: ServiceCall[] = [];
  readonly notes: Array<{ recordId: string; text: string }> = [];
  readonly records = [
    { id: "customer-1", name: "Example Bakery", status: "lead", priority: "normal" },
    { id: "customer-2", name: "Example Books", status: "lead", priority: "normal" },
  ];
  inbox = INBOX.map((row) => ({ ...row }));
  githubReadError = false;
  uncertainWrite = false;
  private faultUsed = false;

  constructor() {
    const composio = new FakeComposioClient(DIRECTORY);
    super({ client: composio });
    this.composio = composio;
    composio.seedGithubReleases([
      {
        owner: "example",
        repo: "widget",
        tag: "v2.1.0",
        name: "Widget 2.1",
        body: "Adds CSV export and fixes duplicate notifications.",
        publishedAt: "2026-01-02T09:00:00Z",
        htmlUrl: "https://example.test/widget/releases/v2.1.0",
      },
      {
        owner: "example",
        repo: "widget",
        tag: "v2.0.0",
        name: "Widget 2.0",
        body: "Adds saved views.",
        publishedAt: "2026-01-01T09:00:00Z",
        htmlUrl: "https://example.test/widget/releases/v2.0.0",
      },
    ]);
  }

  seedGithubReleases(releases: Parameters<FakeComposioClient["seedGithubReleases"]>[0]): void {
    this.composio.seedGithubReleases(releases);
  }

  listGithubReleases() {
    return this.composio.listGithubReleases();
  }

  override async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const connected =
      context.connectedConnections
        ?.filter((c) => c.connectorId === "composio")
        .map((c) => c.externalId) ?? [];
    const inherited = await super.discoverTools(context);
    return [
      ...inherited.filter((t) => t.name.startsWith("GITHUB_")),
      ...(connected.includes("GMAIL")
        ? [
            tool(
              "GMAIL_LIST_MESSAGES",
              "Read inbox messages, with urgency and full body.",
              {},
              [],
              true,
            ),
          ]
        : []),
      ...(connected.includes("CRM") && this.diagnosticChain.length
        ? [
            tool(
              "CRM_READ_DIAGNOSTIC",
              "Read one Aurora diagnostic segment by cursor. Begin with start, then follow nextCursor until null. Only the last segment has the verified component.",
              { cursor: { type: "string" } },
              ["cursor"],
              true,
            ),
          ]
        : []),
      ...(connected.includes("CRM")
        ? [
            tool(
              "CRM_LIST_RECORDS",
              "Read all customer records and their notes. Use to inspect whether a previous write succeeded when its result was uncertain.",
              {},
              [],
              true,
            ),
            tool(
              "CRM_UPDATE_RECORD",
              "Update one customer's status and/or priority by its record ID.",
              {
                recordId: { type: "string" },
                status: { type: "string", enum: ["lead", "active"] },
                priority: { type: "string", enum: ["normal", "high"] },
              },
              ["recordId"],
              false,
            ),
            tool(
              "CRM_CREATE_NOTE",
              "Append a note to a customer. Every call appends a new note, including repeated identical calls. A transport error can occur after the write succeeds; inspect existing notes before retrying.",
              { recordId: { type: "string" }, text: { type: "string" } },
              ["recordId", "text"],
              false,
            ),
          ]
        : []),
      ...(connected.includes(CUSTOMER_SUPPORT_PROVIDERS.salesforce)
        ? [
            tool(
              CUSTOMER_SUPPORT_TOOLS.searchAccounts,
              "Search Salesforce accounts by customer name. Returns account IDs and owners.",
              { query: { type: "string" } },
              ["query"],
              true,
            ),
            tool(
              CUSTOMER_SUPPORT_TOOLS.listOpportunities,
              "Read renewal opportunities for one Salesforce account ID.",
              { accountId: { type: "string" } },
              ["accountId"],
              true,
            ),
          ]
        : []),
      ...(connected.includes(CUSTOMER_SUPPORT_PROVIDERS.zendesk)
        ? [
            tool(
              CUSTOMER_SUPPORT_TOOLS.searchOrganizations,
              "Search Zendesk organizations by customer name. Returns organization IDs.",
              { query: { type: "string" } },
              ["query"],
              true,
            ),
            tool(
              CUSTOMER_SUPPORT_TOOLS.listTickets,
              "Read current support tickets for one Zendesk organization ID.",
              { organizationId: { type: "string" } },
              ["organizationId"],
              true,
            ),
          ]
        : []),
    ];
  }

  override async *execute(
    call: ConnectorCall,
    context: AdapterContext,
  ): AsyncIterable<ConnectorEvent> {
    if (call.tool.startsWith("GITHUB_")) {
      const entry: ServiceCall = {
        tool: call.tool,
        args: structuredClone(call.args),
        outcome: "rejected",
      };
      this.calls.push(entry);
      if (this.githubReadError)
        throw new Error("Release service unavailable; check did not complete.");
      for await (const event of super.execute(call, context)) {
        if (event.type === "result") {
          const { data } = event.data as { data?: { ok?: unknown } };
          entry.outcome = data?.ok === true ? "read" : "rejected";
        }
        if (event.type === "error") entry.outcome = "rejected";
        yield event;
      }
      return;
    }
    const entry: ServiceCall = {
      tool: call.tool,
      args: structuredClone(call.args),
      outcome: "rejected",
    };
    this.calls.push(entry);
    if (call.tool === "CRM_READ_DIAGNOSTIC") {
      const index = this.diagnosticChain.findIndex(
        (segment) => segment.cursor === call.args.cursor,
      );
      if (index < 0) throw new Error("Unknown diagnostic cursor");
      const segment = this.diagnosticChain[index]!;
      entry.outcome = "read";
      yield {
        type: "result",
        data: {
          segment: index + 1,
          nextCursor: segment.nextCursor,
          diagnostic: segment.nextCursor
            ? "Synthetic detailed observation. ".repeat(800)
            : "Verified Aurora component: ledger-indexer. Approval pending; no deployment.",
        },
      };
      return;
    }
    if (call.tool === "GMAIL_LIST_MESSAGES") {
      entry.outcome = "read";
      yield { type: "result", data: { messages: structuredClone(this.inbox) } };
      return;
    }
    if (call.tool === "CRM_LIST_RECORDS") {
      entry.outcome = "read";
      yield {
        type: "result",
        data: { records: structuredClone(this.records), notes: structuredClone(this.notes) },
      };
      return;
    }
    if (call.tool === CUSTOMER_SUPPORT_TOOLS.searchAccounts) {
      const query = requiredQuery(call.args.query);
      entry.outcome = "read";
      yield {
        type: "result",
        data: {
          accounts: structuredClone(
            CUSTOMER_ACCOUNTS.filter((row) => row.name.toLowerCase().includes(query)),
          ),
        },
      };
      return;
    }
    if (call.tool === CUSTOMER_SUPPORT_TOOLS.listOpportunities) {
      const accountId = String(call.args.accountId ?? "");
      if (!CUSTOMER_ACCOUNTS.some((row) => row.id === accountId)) {
        throw new Error("Unknown Salesforce account");
      }
      entry.outcome = "read";
      yield {
        type: "result",
        data: {
          opportunities: structuredClone(
            CUSTOMER_OPPORTUNITIES.filter((row) => row.accountId === accountId),
          ),
        },
      };
      return;
    }
    if (call.tool === CUSTOMER_SUPPORT_TOOLS.searchOrganizations) {
      const query = requiredQuery(call.args.query);
      entry.outcome = "read";
      yield {
        type: "result",
        data: {
          organizations: structuredClone(
            CUSTOMER_ORGANIZATIONS.filter((row) => row.name.toLowerCase().includes(query)),
          ),
        },
      };
      return;
    }
    if (call.tool === CUSTOMER_SUPPORT_TOOLS.listTickets) {
      const organizationId = String(call.args.organizationId ?? "");
      if (!CUSTOMER_ORGANIZATIONS.some((row) => row.id === organizationId)) {
        throw new Error("Unknown Zendesk organization");
      }
      entry.outcome = "read";
      yield {
        type: "result",
        data: {
          tickets: structuredClone(
            CUSTOMER_TICKETS.filter((row) => row.organizationId === organizationId),
          ),
        },
      };
      return;
    }
    const record = this.records.find((row) => row.id === call.args.recordId);
    if (!record) throw new Error("Unknown customer record");
    if (call.tool === "CRM_UPDATE_RECORD") {
      const { status, priority } = call.args;
      if (
        (status !== undefined && status !== "lead" && status !== "active") ||
        (priority !== undefined && priority !== "normal" && priority !== "high") ||
        (status === undefined && priority === undefined)
      )
        throw new Error("Invalid customer update");
      if (status !== undefined) record.status = status;
      if (priority !== undefined) record.priority = priority;
      entry.outcome = "write";
      yield { type: "result", data: { record: structuredClone(record) } };
      return;
    }
    if (
      call.tool === "CRM_CREATE_NOTE" &&
      typeof call.args.text === "string" &&
      call.args.text.length
    ) {
      this.notes.push({ recordId: record.id, text: call.args.text });
      entry.outcome = "write";
      if (this.uncertainWrite && !this.faultUsed) {
        this.faultUsed = true;
        entry.outcome = "uncertain-write";
        throw new Error(
          "Connection closed before confirmation. The write may have succeeded. Inspect current state before retrying.",
        );
      }
      yield { type: "result", data: { ok: true } };
      return;
    }
    throw new Error("Unsupported action or invalid arguments");
  }
}

const CUSTOMER_ACCOUNTS = [
  {
    id: "sf-fairhaven-robotics",
    name: "Fairhaven Robotics",
    owner: "Casey Morgan",
  },
  {
    id: "sf-fairhaven-logistics",
    name: "Fairhaven Logistics",
    owner: "Riley Chen",
  },
] as const;

const CUSTOMER_OPPORTUNITIES = [
  {
    id: "sf-fairhaven-robotics-renewal",
    accountId: "sf-fairhaven-robotics",
    name: "2026 renewal",
    stage: "Negotiation",
    closeDate: "2026-10-15",
    nextStep: "Resolve the SSO escalation before the renewal review on 2026-09-09.",
    risk: "At risk while the production SSO incident remains unresolved.",
  },
  {
    id: "sf-fairhaven-logistics-renewal",
    accountId: "sf-fairhaven-logistics",
    name: "2026 renewal",
    stage: "Closed Won",
    closeDate: "2026-08-10",
    nextStep: "Handoff completed.",
    risk: null,
  },
] as const;

const CUSTOMER_ORGANIZATIONS = [
  { id: "zd-fairhaven-robotics", name: "Fairhaven Robotics" },
  { id: "zd-fairhaven-logistics", name: "Fairhaven Logistics" },
] as const;

const CUSTOMER_TICKETS = [
  {
    id: "ZD-1842",
    organizationId: "zd-fairhaven-robotics",
    subject: "Production users cannot sign in with SSO",
    status: "open",
    priority: "urgent",
    assignee: "Avery Patel",
    latestUpdate:
      "Engineering reproduced the audience mismatch and is testing a configuration fix.",
  },
  {
    id: "ZD-1811",
    organizationId: "zd-fairhaven-logistics",
    subject: "Add a billing contact",
    status: "solved",
    priority: "low",
    assignee: "Jamie Ortiz",
    latestUpdate: "Billing contact added.",
  },
] as const;

function requiredQuery(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("A search query is required");
  return value.trim().toLowerCase();
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  readOnly: boolean,
): ConnectorTool {
  return {
    name,
    description,
    readOnly,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
  };
}
