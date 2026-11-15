import type { AppEmulatorOptions, AppTool } from "./app-emulator.js";
import { AppEmulator, AppError, paginate, queryTerms, stableId } from "./app-emulator.js";

export type MailAttachment = { filename: string; mimeType: string; size: number };
export type MailMessageSeed = {
  from: string;
  to: string[];
  cc?: string[];
  date: string;
  body: string;
  /** Defaults to the thread's subject, with "Re: " on replies. */
  subject?: string;
  attachments?: MailAttachment[];
  unread?: boolean;
};
export type MailThreadSeed = {
  /** Stable key; the thread id derives from it. */
  key: string;
  subject: string;
  /** User and category labels; INBOX, SENT and UNREAD follow from the messages. */
  labels?: string[];
  starred?: boolean;
  archived?: boolean;
  messages: MailMessageSeed[];
};
export type MailSeed = {
  account: { name: string; email: string };
  labels: string[];
  threads: MailThreadSeed[];
};

type Message = {
  id: string;
  threadId: string;
  headers: Record<string, string>;
  from: string;
  to: string[];
  cc: string[];
  date: string;
  subject: string;
  body: string;
  attachments: MailAttachment[];
  unread: boolean;
};
type Thread = { id: string; labels: Set<string>; messages: Message[] };
type Draft = {
  id: string;
  threadId: string | null;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  headers: Record<string, string>;
  updated: string;
};

const SYSTEM_LABELS = ["INBOX", "SENT", "DRAFT", "UNREAD", "STARRED", "IMPORTANT", "SPAM", "TRASH"];
const CATEGORY_LABELS = ["CATEGORY_PERSONAL", "CATEGORY_UPDATES", "CATEGORY_PROMOTIONS"];
const DAY = 86_400_000;
const SEARCH_OPERATORS = new Set(
  "from to cc subject label in category is has filename after before newer_than older_than".split(
    " ",
  ),
);
type SearchTerm = ReturnType<typeof queryTerms>[number];

export const mailThreadId = (key: string) => stableId(`mail-thread:${key}`, 16);

/** An email address from "Name <address>" or a bare address, lowercased. */
/** The bare, lowercased address from `Name <address>` or a plain address. */
export const address = (value: string) =>
  (value.match(/<([^>]+)>/)?.[1] ?? value).trim().toLowerCase();
const isAddress = (value: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address(value));

/** RFC 5322 date in UTC, as mail headers carry it. */
function rfcDate(iso: string) {
  const date = new Date(iso);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

const snippet = (body: string) => body.replace(/\s+/g, " ").trim().slice(0, 140);

/**
 * A mailbox: threads of messages with real headers, labels, a search language with the usual
 * operators, paginated listings, and drafts and sends recorded as writes.
 */
export class MailEmulator extends AppEmulator {
  readonly kind = "mail";
  readonly displayName = "Mail";
  readonly account: MailSeed["account"];
  readonly threads = new Map<string, Thread>();
  readonly drafts = new Map<string, Draft>();
  private readonly userLabels: Set<string>;
  private readonly domain: string;

  constructor(seed: MailSeed, options: AppEmulatorOptions) {
    super(options);
    this.account = seed.account;
    this.userLabels = new Set(seed.labels);
    this.domain = this.account.email.split("@")[1] ?? "mail.example";
    for (const thread of seed.threads) this.addSeedThread(thread);
  }

  private addSeedThread(seed: MailThreadSeed) {
    const id = mailThreadId(seed.key);
    const labels = new Set(seed.labels ?? []);
    for (const label of labels)
      if (!this.labelExists(label))
        throw new Error(`Seed thread ${seed.key} has unknown label ${label}`);
    if (seed.starred) labels.add("STARRED");
    const thread: Thread = { id, labels, messages: [] };
    const sorted = [...seed.messages].sort((a, b) => a.date.localeCompare(b.date));
    sorted.forEach((message, index) => {
      const messageId = stableId(`mail-message:${seed.key}:${index}`, 16);
      const subject = message.subject ?? (index === 0 ? seed.subject : `Re: ${seed.subject}`);
      thread.messages.push(
        this.buildMessage(thread, messageId, { ...message, subject, cc: message.cc ?? [] }),
      );
      if (address(message.from) === this.account.email) labels.add("SENT");
      else if (!seed.archived) labels.add("INBOX");
    });
    this.threads.set(id, thread);
  }

  private buildMessage(
    thread: Thread,
    id: string,
    message: Omit<MailMessageSeed, "cc"> & { cc: string[]; subject: string },
  ): Message {
    const previous = thread.messages.at(-1);
    const messageIdHeader = `<${id}@${address(message.from).split("@")[1] ?? this.domain}>`;
    const references = thread.messages.map((m) => m.headers["Message-ID"]!).join(" ");
    const headers: Record<string, string> = {
      From: message.from,
      To: message.to.join(", "),
      ...(message.cc.length ? { Cc: message.cc.join(", ") } : {}),
      Date: rfcDate(message.date),
      Subject: message.subject,
      "Message-ID": messageIdHeader,
      ...(previous
        ? { "In-Reply-To": previous.headers["Message-ID"]!, References: references }
        : {}),
      "MIME-Version": "1.0",
      "Content-Type": message.attachments?.length ? "multipart/mixed" : "text/plain; charset=UTF-8",
    };
    return {
      id,
      threadId: thread.id,
      headers,
      from: message.from,
      to: message.to,
      cc: message.cc,
      date: message.date,
      subject: message.subject,
      body: message.body,
      attachments: message.attachments ?? [],
      unread: message.unread ?? false,
    };
  }

  private labelExists(label: string) {
    return (
      SYSTEM_LABELS.includes(label) || CATEGORY_LABELS.includes(label) || this.userLabels.has(label)
    );
  }

  private thread(id: unknown) {
    const thread = this.threads.get(String(id));
    if (!thread) throw new AppError("not_found", `Thread not found: ${String(id)}`);
    return thread;
  }

  /** Labels as a client shows them: UNREAD when any message is unread. */
  private labelsOf(thread: Thread) {
    const labels = new Set(thread.labels);
    if (thread.messages.some((m) => m.unread)) labels.add("UNREAD");
    return [...labels].sort();
  }

  private summary(thread: Thread) {
    const last = thread.messages.at(-1)!;
    return {
      id: thread.id,
      subject: thread.messages[0]!.subject,
      snippet: snippet(last.body),
      from: last.from,
      participants: [...new Set(thread.messages.flatMap((m) => [m.from, ...m.to]))],
      last_message_date: rfcDate(last.date),
      message_count: thread.messages.length,
      labels: this.labelsOf(thread),
      has_attachments: thread.messages.some((m) => m.attachments.length > 0),
    };
  }

  /**
   * Common mail search operators; every term must match a message in the thread, and terms
   * joined by OR need only one of them to.
   */
  private matches(thread: Thread, terms: SearchTerm[]) {
    const scope = terms.find((term) => term.key === "in" && !term.negate)?.text;
    const labels = new Set(this.labelsOf(thread).map((label) => label.toLowerCase()));
    if (scope !== "anywhere" && (labels.has("trash") || labels.has("spam")))
      if (scope !== "trash" && scope !== "spam") return false;
    const groups: Array<typeof terms> = [];
    for (const term of terms) {
      const last = groups.at(-1);
      if (term.or && last) last.push(term);
      else groups.push([term]);
    }
    return groups
      .map((group) =>
        group.map((term) => this.termMatches(thread, labels, term) !== term.negate).some(Boolean),
      )
      .every(Boolean);
  }

  private termMatches(
    thread: Thread,
    labels: Set<string>,
    term: { text: string; key?: string },
  ): boolean {
    const { text, key } = term;
    const any = (predicate: (m: Message) => boolean) => thread.messages.some(predicate);
    const people = (values: string[]) => values.join(" ").toLowerCase().includes(text);
    switch (key) {
      case undefined:
        return any((m) =>
          [m.subject, m.body, m.from, ...m.to, ...m.cc, ...m.attachments.map((a) => a.filename)]
            .join(" ")
            .toLowerCase()
            .includes(text),
        );
      // "me" is the account itself, never a substring of someone else's name or address.
      case "from":
        return any((m) =>
          text === "me" ? address(m.from) === this.account.email : people([m.from]),
        );
      case "to":
        return any((m) =>
          text === "me" ? m.to.some((t) => address(t) === this.account.email) : people(m.to),
        );
      case "cc":
        return any((m) => people(m.cc));
      case "subject":
        return thread.messages[0]!.subject.toLowerCase().includes(text);
      case "label":
      case "in":
        if (text === "anywhere") return true;
        return (
          labels.has(text) || labels.has(text.replace(/-/g, "_")) || labels.has(`category_${text}`)
        );
      case "category":
        return labels.has(`category_${text}`);
      case "is":
        if (text === "unread") return labels.has("unread");
        if (text === "read") return !labels.has("unread");
        return labels.has(text);
      case "has":
        return text === "attachment" && any((m) => m.attachments.length > 0);
      case "filename":
        return any((m) => m.attachments.some((a) => a.filename.toLowerCase().includes(text)));
      case "after":
      case "before":
      case "newer_than":
      case "older_than": {
        const bound = this.dateBound(key, text);
        return any((m) =>
          key === "after" || key === "newer_than" ? m.date >= bound : m.date < bound,
        );
      }
      default:
        return false;
    }
  }

  /** Rejects what the search cannot evaluate before any thread is filtered. */
  private parseQuery(query: string) {
    // Grouping isn't supported; refuse it rather than search for the literal brackets.
    if (/[(){}]/.test(query.replace(/"[^"]*"/g, "")))
      throw new AppError(
        "invalid_argument",
        "Grouping with brackets is not supported; use OR between single terms instead.",
      );
    const terms = queryTerms(query);
    for (const { key, text } of terms) {
      if (key === undefined) continue;
      if (!SEARCH_OPERATORS.has(key))
        throw new AppError("invalid_argument", `Unsupported search operator: ${key}:`);
      if (key === "has" && text !== "attachment")
        throw new AppError("invalid_argument", "Only has:attachment is supported.");
      if (["after", "before", "newer_than", "older_than"].includes(key)) this.dateBound(key, text);
    }
    return terms;
  }

  private dateBound(key: string, text: string) {
    if (key === "newer_than" || key === "older_than") {
      const match = text.match(/^(\d+)([dmy])$/);
      if (!match)
        throw new AppError(
          "invalid_argument",
          `Invalid ${key} value ${text}; use e.g. 7d, 2m, 1y.`,
        );
      const days =
        Number(match[1]) * ({ d: 1, m: 30, y: 365 } as const)[match[2] as "d" | "m" | "y"];
      return new Date(this.now.getTime() - days * DAY).toISOString();
    }
    const match = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
    if (!match) throw new AppError("invalid_argument", `Invalid date ${text}; use YYYY/MM/DD.`);
    return new Date(
      Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
    ).toISOString();
  }

  private recipients(value: unknown, field: string) {
    const list = (Array.isArray(value) ? value : value === undefined ? [] : [value]).flatMap((v) =>
      String(v)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    );
    for (const entry of list)
      if (!isAddress(entry))
        throw new AppError("invalid_argument", `Invalid ${field} address: ${entry}`);
    return list;
  }

  private composeDraft(args: Record<string, unknown>, existing?: Draft): Draft {
    const threadId = args.thread_id ? this.thread(args.thread_id).id : (existing?.threadId ?? null);
    const to = args.to === undefined && existing ? existing.to : this.recipients(args.to, "to");
    if (!to.length) throw new AppError("invalid_argument", "At least one recipient is required.");
    const thread = threadId ? this.threads.get(threadId) : undefined;
    const last = thread?.messages.at(-1);
    const subject = String(
      args.subject ??
        existing?.subject ??
        (thread ? `Re: ${thread.messages[0]!.subject.replace(/^re:\s*/i, "")}` : ""),
    );
    const id = existing?.id ?? this.nextId("r-", 18);
    return {
      id,
      threadId,
      to,
      cc: args.cc === undefined && existing ? existing.cc : this.recipients(args.cc, "cc"),
      subject,
      body: String(args.body ?? existing?.body ?? ""),
      headers: {
        From: `${this.account.name} <${this.account.email}>`,
        To: to.join(", "),
        Subject: subject,
        ...(last
          ? {
              "In-Reply-To": last.headers["Message-ID"]!,
              References: thread!.messages.map((m) => m.headers["Message-ID"]).join(" "),
            }
          : {}),
      },
      updated: this.stamp(),
    };
  }

  private draftView(draft: Draft) {
    return {
      id: draft.id,
      thread_id: draft.threadId,
      to: draft.to,
      cc: draft.cc,
      subject: draft.subject,
      body: draft.body,
      headers: draft.headers,
      updated: rfcDate(draft.updated),
    };
  }

  private deliver(draft: Draft) {
    const thread: Thread = draft.threadId
      ? this.threads.get(draft.threadId)!
      : { id: this.nextId("", 16), labels: new Set(), messages: [] };
    if (!draft.threadId) this.threads.set(thread.id, thread);
    const message = this.buildMessage(thread, this.nextId("", 16), {
      from: `${this.account.name} <${this.account.email}>`,
      to: draft.to,
      cc: draft.cc,
      date: this.stamp(),
      subject: draft.subject,
      body: draft.body,
    });
    thread.messages.push(message);
    thread.labels.add("SENT");
    return { id: message.id, thread_id: thread.id, labels: ["SENT"] };
  }

  tools(): AppTool[] {
    return [
      {
        name: "search_threads",
        description:
          'Search the mailbox and return matching threads, newest first. Supports operators: from:, to:, cc:, subject:, label:, in:inbox|sent|trash|anywhere, is:unread|read|starred|important, has:attachment, filename:, after:YYYY/MM/DD, before:YYYY/MM/DD, newer_than:7d, older_than:1m, "exact phrase", -term to exclude, and OR between terms. Spam and trash are excluded unless in: says otherwise.',
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query; empty lists the inbox." },
            max_results: { type: "integer", description: "Threads per page, 1-50. Default 10." },
            page_token: { type: "string", description: "next_page_token from a previous page." },
          },
          additionalProperties: false,
        },
        readOnly: true,
        run: (args) => {
          const query = String(args.query ?? "").trim() || "in:inbox";
          const terms = this.parseQuery(query);
          const matched = [...this.threads.values()]
            .filter((thread) => this.matches(thread, terms))
            .sort((a, b) => b.messages.at(-1)!.date.localeCompare(a.messages.at(-1)!.date));
          const { page, next } = paginate(matched, {
            size: args.max_results,
            token: args.page_token,
            scope: `threads:${query}`,
            fallback: 10,
            max: 50,
          });
          return {
            threads: page.map((thread) => this.summary(thread)),
            next_page_token: next,
            result_size_estimate: matched.length,
          };
        },
      },
      {
        name: "get_thread",
        description:
          "Get every message in a thread with headers and plain-text bodies. Use format=metadata for headers only.",
        inputSchema: {
          type: "object",
          properties: {
            thread_id: { type: "string" },
            format: { type: "string", enum: ["full", "metadata"] },
          },
          required: ["thread_id"],
          additionalProperties: false,
        },
        readOnly: true,
        run: (args) => {
          const thread = this.thread(args.thread_id);
          return {
            id: thread.id,
            labels: this.labelsOf(thread),
            messages: thread.messages.map((m) => ({
              id: m.id,
              thread_id: thread.id,
              labels: [...(m.unread ? ["UNREAD"] : [])],
              headers: m.headers,
              snippet: snippet(m.body),
              ...(args.format === "metadata" ? {} : { body: m.body }),
              attachments: m.attachments.map((a) => ({
                filename: a.filename,
                mime_type: a.mimeType,
                size: a.size,
              })),
            })),
          };
        },
      },
      {
        name: "create_draft",
        description:
          "Save a draft without sending it. Pass thread_id to draft a reply in that thread; the subject defaults to the thread's with Re: and reply headers are set.",
        inputSchema: {
          type: "object",
          properties: {
            to: {
              type: ["array", "string"],
              items: { type: "string" },
              description: "Recipient addresses.",
            },
            cc: { type: ["array", "string"], items: { type: "string" } },
            subject: { type: "string" },
            body: { type: "string", description: "Plain-text body." },
            thread_id: { type: "string", description: "Thread to reply in." },
          },
          required: ["to", "body"],
          additionalProperties: false,
        },
        readOnly: false,
        run: (args) => {
          const draft = this.composeDraft(args);
          this.drafts.set(draft.id, draft);
          this.record({
            tool: "create_draft",
            args,
            target: draft.id,
            after: this.draftView(draft),
          });
          return { id: draft.id, message: { thread_id: draft.threadId, labels: ["DRAFT"] } };
        },
      },
      {
        name: "update_draft",
        description: "Replace fields of a saved draft. Omitted fields keep their value.",
        inputSchema: {
          type: "object",
          properties: {
            draft_id: { type: "string" },
            to: { type: ["array", "string"], items: { type: "string" } },
            cc: { type: ["array", "string"], items: { type: "string" } },
            subject: { type: "string" },
            body: { type: "string" },
          },
          required: ["draft_id"],
          additionalProperties: false,
        },
        readOnly: false,
        run: (args) => {
          const existing = this.drafts.get(String(args.draft_id));
          if (!existing)
            throw new AppError("not_found", `Draft not found: ${String(args.draft_id)}`);
          const draft = this.composeDraft(args, existing);
          this.drafts.set(draft.id, draft);
          this.record({
            tool: "update_draft",
            args,
            target: draft.id,
            before: this.draftView(existing),
            after: this.draftView(draft),
          });
          return { id: draft.id, message: { thread_id: draft.threadId, labels: ["DRAFT"] } };
        },
      },
      {
        name: "send_draft",
        description: "Send a saved draft.",
        inputSchema: {
          type: "object",
          properties: { draft_id: { type: "string" } },
          required: ["draft_id"],
          additionalProperties: false,
        },
        readOnly: false,
        run: (args) => {
          const draft = this.drafts.get(String(args.draft_id));
          if (!draft) throw new AppError("not_found", `Draft not found: ${String(args.draft_id)}`);
          this.drafts.delete(draft.id);
          const sent = this.deliver(draft);
          this.record({ tool: "send_draft", args, target: sent.id, after: this.draftView(draft) });
          return sent;
        },
      },
      {
        name: "send_message",
        description: "Send a new message, or a reply when thread_id is given.",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: ["array", "string"], items: { type: "string" } },
            cc: { type: ["array", "string"], items: { type: "string" } },
            subject: { type: "string" },
            body: { type: "string" },
            thread_id: { type: "string" },
          },
          required: ["to", "body"],
          additionalProperties: false,
        },
        readOnly: false,
        run: (args) => {
          const draft = this.composeDraft(args);
          const sent = this.deliver(draft);
          this.record({
            tool: "send_message",
            args,
            target: sent.id,
            after: this.draftView(draft),
          });
          return sent;
        },
      },
      {
        name: "modify_thread_labels",
        description:
          "Add or remove labels on a thread, e.g. remove INBOX to archive or UNREAD to mark read.",
        inputSchema: {
          type: "object",
          properties: {
            thread_id: { type: "string" },
            add_labels: { type: "array", items: { type: "string" } },
            remove_labels: { type: "array", items: { type: "string" } },
          },
          required: ["thread_id"],
          additionalProperties: false,
        },
        readOnly: false,
        run: (args) => {
          const thread = this.thread(args.thread_id);
          const add = (args.add_labels as string[] | undefined) ?? [];
          const remove = (args.remove_labels as string[] | undefined) ?? [];
          for (const label of [...add, ...remove])
            if (!this.labelExists(label))
              throw new AppError("invalid_argument", `Invalid label: ${label}`);
          const before = this.labelsOf(thread);
          for (const label of add) if (label !== "UNREAD") thread.labels.add(label);
          for (const label of remove) thread.labels.delete(label);
          if (remove.includes("UNREAD")) for (const m of thread.messages) m.unread = false;
          if (add.includes("UNREAD")) thread.messages.at(-1)!.unread = true;
          this.record({
            tool: "modify_thread_labels",
            args,
            target: thread.id,
            before,
            after: this.labelsOf(thread),
          });
          return { id: thread.id, labels: this.labelsOf(thread) };
        },
      },
    ];
  }
}
