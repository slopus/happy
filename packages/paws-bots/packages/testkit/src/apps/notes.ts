import type { AppEmulatorOptions, AppTool } from "./app-emulator.js";
import { AppEmulator, AppError, paginate, stableId } from "./app-emulator.js";

export type BlockType =
  | "heading_1"
  | "heading_2"
  | "heading_3"
  | "paragraph"
  | "bulleted_list_item"
  | "numbered_list_item"
  | "to_do"
  | "quote"
  | "code"
  | "divider";
export type BlockSeed = { type: BlockType; text?: string; checked?: boolean };
export type PropertyType =
  | "title"
  | "rich_text"
  | "select"
  | "multi_select"
  | "status"
  | "date"
  | "number"
  | "checkbox"
  | "people"
  | "url";
export type PropertySchema = { type: PropertyType; options?: string[] };
export type PropertyValue = string | number | boolean | string[] | null;
export type PageSeed = {
  key: string;
  title: string;
  /** Parent page or database key; omitted for a top-level workspace page. */
  parent?: string;
  icon?: string;
  /** For a database row, its properties other than the title. */
  properties?: Record<string, PropertyValue>;
  blocks?: BlockSeed[];
  edited: string;
  editedBy?: string;
  /** View-only pages refuse edits; unshared pages are invisible to the connection. */
  access?: "edit" | "view" | "unshared";
};
export type DatabaseSeed = {
  key: string;
  title: string;
  parent?: string;
  description?: string;
  properties: Record<string, PropertySchema>;
  edited: string;
  access?: "edit" | "view" | "unshared";
};
export type NotesSeed = {
  workspace: string;
  baseUrl: string;
  /** The connection's member, written as the editor of every change. */
  member: string;
  databases: DatabaseSeed[];
  pages: PageSeed[];
};

type Block = BlockSeed & { id: string };
type Page = Omit<PageSeed, "blocks" | "properties"> & {
  id: string;
  parentId: string | null;
  properties: Record<string, PropertyValue>;
  blocks: Block[];
  created: string;
};
type Database = DatabaseSeed & { id: string; parentId: string | null };

/** A UUID-shaped id, stable for a seed key, as page-and-database services use. */
export function noteId(key: string) {
  const hex = stableId(`notes:${key}`, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const BLOCK_PAGE = 50;
const FILTER_CONDITIONS = [
  "equals",
  "does_not_equal",
  "contains",
  "does_not_contain",
  "is_empty",
  "is_not_empty",
  "before",
  "after",
  "on_or_before",
  "on_or_after",
  "greater_than",
  "less_than",
] as const;
type Filter =
  | { property: string; condition: (typeof FILTER_CONDITIONS)[number]; value?: PropertyValue }
  | { and: Filter[] }
  | { or: Filter[] };

/** Markdown-ish lines to blocks, the way such services import pasted text. */
function blocksFromText(text: string): BlockSeed[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const rules: Array<[RegExp, BlockType, boolean?]> = [
        [/^### (.*)/, "heading_3"],
        [/^## (.*)/, "heading_2"],
        [/^# (.*)/, "heading_1"],
        [/^- \[x\] (.*)/i, "to_do", true],
        [/^- \[ \] (.*)/, "to_do", false],
        [/^[-*] (.*)/, "bulleted_list_item"],
        [/^\d+\. (.*)/, "numbered_list_item"],
        [/^> (.*)/, "quote"],
      ];
      for (const [pattern, type, checked] of rules) {
        const match = line.match(pattern);
        if (match) return { type, text: match[1]!, ...(checked === undefined ? {} : { checked }) };
      }
      return line.trim() === "---" ? { type: "divider" } : { type: "paragraph", text: line };
    });
}

/**
 * A notes workspace: nested pages made of blocks and databases whose rows are pages with typed
 * properties. Search matches titles, as these services do; databases filter, sort and paginate.
 */
export class NotesEmulator extends AppEmulator {
  readonly kind = "notes";
  readonly displayName = "Notes";
  readonly pages = new Map<string, Page>();
  readonly databases = new Map<string, Database>();
  private readonly seed: NotesSeed;

  constructor(seed: NotesSeed, options: AppEmulatorOptions) {
    super(options);
    this.seed = seed;
    for (const database of seed.databases)
      this.databases.set(noteId(database.key), {
        ...database,
        id: noteId(database.key),
        parentId: database.parent ? noteId(database.parent) : null,
      });
    for (const page of seed.pages) {
      const id = noteId(page.key);
      const parentId = page.parent ? noteId(page.parent) : null;
      const database = parentId ? this.databases.get(parentId) : undefined;
      const titleProperty = database ? this.titleProperty(database) : "title";
      const stored: Page = {
        ...page,
        id,
        parentId,
        properties: { [titleProperty]: page.title, ...(page.properties ?? {}) },
        blocks: (page.blocks ?? []).map((block, index) => ({
          ...block,
          id: noteId(`${page.key}:block:${index}`),
        })),
        created: page.edited,
      };
      if (database) this.validateProperties(database, stored.properties, `Seed row ${page.key}`);
      this.pages.set(id, stored);
    }
  }

  private titleProperty(database: Database) {
    return (
      Object.entries(database.properties).find(([, schema]) => schema.type === "title")?.[0] ??
      "Name"
    );
  }

  private url(id: string, title: string) {
    const slug = title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return `${this.seed.baseUrl.replace(/\/$/, "")}/${slug}-${id.replace(/-/g, "")}`;
  }

  private parentOf(parentId: string | null) {
    if (!parentId) return { type: "workspace", name: this.seed.workspace };
    const database = this.databases.get(parentId);
    if (database) return { type: "database", id: parentId, title: database.title };
    return { type: "page", id: parentId, title: this.pages.get(parentId)?.title ?? "" };
  }

  /** Unshared content, and anything inside it, does not exist as far as the connection can tell. */
  private hidden(id: string) {
    for (let at: string | null = id; at; ) {
      const node: Page | Database | undefined = this.pages.get(at) ?? this.databases.get(at);
      if (!node) return false;
      if (node.access === "unshared") return true;
      at = node.parentId;
    }
    return false;
  }

  private page(id: unknown) {
    const page = this.pages.get(String(id).trim());
    if (!page || this.hidden(page.id))
      throw new AppError(
        "not_found",
        `Page not found: ${String(id)}. It may not be shared with this connection.`,
      );
    return page;
  }

  private database(id: unknown) {
    const database = this.databases.get(String(id).trim());
    if (!database || this.hidden(database.id))
      throw new AppError(
        "not_found",
        `Database not found: ${String(id)}. It may not be shared with this connection.`,
      );
    return database;
  }

  private editable(page: Page) {
    const database = page.parentId ? this.databases.get(page.parentId) : undefined;
    if (page.access === "view" || database?.access === "view")
      throw new AppError(
        "permission_denied",
        `This connection has view-only access to "${page.title}".`,
      );
    return page;
  }

  private validateProperties(
    database: Database,
    values: Record<string, PropertyValue>,
    context: string,
  ) {
    for (const [name, value] of Object.entries(values)) {
      const schema = database.properties[name];
      if (!schema)
        throw new AppError(
          "invalid_argument",
          `${context}: ${name} is not a property of ${database.title}. Properties: ${Object.keys(database.properties).join(", ")}`,
        );
      if (value === null) continue;
      const fail = (expected: string) =>
        new AppError(
          "invalid_argument",
          `${context}: ${name} is a ${schema.type} property; expected ${expected}.`,
        );
      switch (schema.type) {
        case "select":
        case "status":
          if (typeof value !== "string") throw fail("one option name");
          if (!schema.options?.includes(value))
            throw new AppError(
              "invalid_argument",
              `${context}: "${value}" is not an option for ${name}. Options: ${schema.options?.join(", ")}`,
            );
          break;
        case "multi_select":
        case "people":
          if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
            throw fail("a list of names");
          if (schema.type === "multi_select")
            for (const option of value)
              if (!schema.options?.includes(option))
                throw new AppError(
                  "invalid_argument",
                  `${context}: "${option}" is not an option for ${name}. Options: ${schema.options?.join(", ")}`,
                );
          break;
        case "date":
          if (
            typeof value !== "string" ||
            !/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(value) ||
            Number.isNaN(Date.parse(value)) ||
            new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !==
              value.slice(0, 10)
          )
            throw fail("an ISO 8601 date such as 2026-11-20");
          break;
        case "number":
          if (typeof value !== "number") throw fail("a number");
          break;
        case "checkbox":
          if (typeof value !== "boolean") throw fail("true or false");
          break;
        default:
          if (typeof value !== "string") throw fail("text");
      }
    }
  }

  private summary(page: Page) {
    return {
      object: "page",
      id: page.id,
      title: page.title,
      url: this.url(page.id, page.title),
      parent: this.parentOf(page.parentId),
      last_edited_time: page.edited,
    };
  }

  private row(page: Page) {
    return {
      id: page.id,
      url: this.url(page.id, page.title),
      properties: page.properties,
      last_edited_time: page.edited,
      ...(page.editedBy ? { last_edited_by: page.editedBy } : {}),
    };
  }

  private matchesFilter(page: Page, filter: Filter, database: Database): boolean {
    if ("and" in filter) return filter.and.every((f) => this.matchesFilter(page, f, database));
    if ("or" in filter) return filter.or.some((f) => this.matchesFilter(page, f, database));
    const schema = database.properties[filter.property];
    if (!schema)
      throw new AppError(
        "invalid_argument",
        `Could not find property ${filter.property}. Properties: ${Object.keys(database.properties).join(", ")}`,
      );
    if (!FILTER_CONDITIONS.includes(filter.condition))
      throw new AppError(
        "invalid_argument",
        `Unknown condition ${String(filter.condition)}. Use one of: ${FILTER_CONDITIONS.join(", ")}`,
      );
    const stored = page.properties[filter.property] ?? null;
    // A date-time compares as its day, so a same-day time still matches a date filter.
    const day = (v: unknown) =>
      schema.type === "date" && typeof v === "string" ? v.slice(0, 10) : v;
    const value = day(stored) as PropertyValue;
    const empty = value === null || value === "" || (Array.isArray(value) && value.length === 0);
    const text = (v: unknown) => (Array.isArray(v) ? v.join(" ") : String(v ?? "")).toLowerCase();
    const wanted = day(filter.value);
    switch (filter.condition) {
      case "is_empty":
        return empty;
      case "is_not_empty":
        return !empty;
      case "equals":
        return Array.isArray(value) ? value.includes(String(wanted)) : text(value) === text(wanted);
      case "does_not_equal":
        return Array.isArray(value)
          ? !value.includes(String(wanted))
          : text(value) !== text(wanted);
      case "contains":
        return text(value).includes(text(wanted));
      case "does_not_contain":
        return !text(value).includes(text(wanted));
      case "before":
      case "less_than":
        return (
          !empty &&
          (typeof value === "number" ? value < Number(wanted) : String(value) < String(wanted))
        );
      case "after":
      case "greater_than":
        return (
          !empty &&
          (typeof value === "number" ? value > Number(wanted) : String(value) > String(wanted))
        );
      case "on_or_before":
        return !empty && String(value) <= String(wanted);
      case "on_or_after":
        return !empty && String(value) >= String(wanted);
    }
  }

  private blocksPage(page: Page, cursor: unknown) {
    const { page: blocks, next } = paginate(page.blocks, {
      size: BLOCK_PAGE,
      token: cursor,
      scope: `blocks:${page.id}`,
      fallback: BLOCK_PAGE,
      max: BLOCK_PAGE,
    });
    return { blocks, has_more: next !== null, next_cursor: next };
  }

  tools(): AppTool[] {
    const cursor = { type: "string", description: "next_cursor from a previous page." };
    const size = { type: "integer", description: "Results per page, 1-100. Default 10." };
    const properties = {
      type: "object",
      description:
        "Property values by name: text for title, rich_text and url; an option name for select and status; a list for multi_select and people; YYYY-MM-DD for date; number; true/false for checkbox; null to clear.",
    };
    return [
      {
        name: "search",
        description:
          "Search page and database titles in the workspace, most recently edited first. An empty query lists everything shared with this connection.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            filter: { type: "string", enum: ["page", "database"] },
            page_size: size,
            start_cursor: cursor,
          },
          additionalProperties: false,
        },
        readOnly: true,
        run: (args) => {
          const query = String(args.query ?? "")
            .toLowerCase()
            .trim();
          const words = query.split(/\s+/).filter(Boolean);
          const hit = (title: string) => words.every((w) => title.toLowerCase().includes(w));
          const results = [
            ...(args.filter === "page"
              ? []
              : [...this.databases.values()]
                  .filter((d) => !this.hidden(d.id) && hit(d.title))
                  .map((d) => ({
                    object: "database",
                    id: d.id,
                    title: d.title,
                    url: this.url(d.id, d.title),
                    parent: this.parentOf(d.parentId),
                    last_edited_time: d.edited,
                  }))),
            ...(args.filter === "database"
              ? []
              : [...this.pages.values()]
                  .filter((p) => !this.hidden(p.id) && hit(p.title))
                  .map((p) => this.summary(p))),
          ].sort((a, b) => b.last_edited_time.localeCompare(a.last_edited_time));
          const { page, next } = paginate(results, {
            size: args.page_size,
            token: args.start_cursor,
            scope: `search:${query}:${String(args.filter ?? "")}`,
            fallback: 10,
            max: 100,
          });
          return { results: page, has_more: next !== null, next_cursor: next };
        },
      },
      {
        name: "get_database",
        description:
          "Get a database's title, description and property schema, including select options.",
        inputSchema: {
          type: "object",
          properties: { database_id: { type: "string" } },
          required: ["database_id"],
          additionalProperties: false,
        },
        readOnly: true,
        run: (args) => {
          const database = this.database(args.database_id);
          return {
            id: database.id,
            title: database.title,
            ...(database.description ? { description: database.description } : {}),
            url: this.url(database.id, database.title),
            parent: this.parentOf(database.parentId),
            properties: database.properties,
          };
        },
      },
      {
        name: "list_database_rows",
        description:
          'List a database\'s rows (pages) with their properties. filter is {"property","condition","value"} with conditions equals, does_not_equal, contains, does_not_contain, is_empty, is_not_empty, before, after, on_or_before, on_or_after, greater_than, less_than; combine with {"and":[...]} or {"or":[...]}. sorts is [{"property","direction":"ascending"|"descending"}]. Default order is last edited first.',
        inputSchema: {
          type: "object",
          properties: {
            database_id: { type: "string" },
            filter: { type: "object" },
            sorts: { type: "array", items: { type: "object" } },
            page_size: size,
            start_cursor: cursor,
          },
          required: ["database_id"],
          additionalProperties: false,
        },
        readOnly: true,
        run: (args) => {
          const database = this.database(args.database_id);
          const filter = args.filter as Filter | undefined;
          const sorts =
            (args.sorts as Array<{ property: string; direction?: string }> | undefined) ?? [];
          for (const sort of sorts)
            if (!database.properties[sort.property])
              throw new AppError(
                "invalid_argument",
                `Could not find sort property ${sort.property}.`,
              );
          const rows = [...this.pages.values()]
            .filter((p) => p.parentId === database.id && !this.hidden(p.id))
            .filter((p) => !filter || this.matchesFilter(p, filter, database))
            .sort((a, b) => {
              for (const sort of sorts) {
                const left = String(a.properties[sort.property] ?? "");
                const right = String(b.properties[sort.property] ?? "");
                const order = left.localeCompare(right, undefined, { numeric: true });
                if (order) return sort.direction === "descending" ? -order : order;
              }
              return b.edited.localeCompare(a.edited) || a.id.localeCompare(b.id);
            });
          const { page, next } = paginate(rows, {
            size: args.page_size,
            token: args.start_cursor,
            scope: `rows:${database.id}:${JSON.stringify(filter ?? null)}:${JSON.stringify(sorts)}`,
            fallback: 10,
            max: 100,
          });
          return {
            results: page.map((p) => this.row(p)),
            has_more: next !== null,
            next_cursor: next,
          };
        },
      },
      {
        name: "read_page",
        description: "Read a page: its properties and content blocks, 50 blocks at a time.",
        inputSchema: {
          type: "object",
          properties: { page_id: { type: "string" }, start_cursor: cursor },
          required: ["page_id"],
          additionalProperties: false,
        },
        readOnly: true,
        run: (args) => {
          const page = this.page(args.page_id);
          const children = [
            ...[...this.pages.values()].filter((p) => p.parentId === page.id && !this.hidden(p.id)),
            ...[...this.databases.values()].filter(
              (d) => d.parentId === page.id && !this.hidden(d.id),
            ),
          ].map((child) => ({
            object: this.databases.has(child.id) ? "database" : "page",
            id: child.id,
            title: child.title,
          }));
          return {
            ...this.summary(page),
            properties: page.properties,
            ...(children.length ? { child_pages: children } : {}),
            ...this.blocksPage(page, args.start_cursor),
          };
        },
      },
      {
        name: "create_page",
        description:
          "Create a page under a parent page, or a row in a database with properties. content is Markdown-style text: # headings, - bullets, - [ ] to-dos, > quotes.",
        inputSchema: {
          type: "object",
          properties: {
            parent_page_id: { type: "string" },
            database_id: { type: "string" },
            title: { type: "string" },
            properties,
            content: { type: "string" },
          },
          required: ["title"],
          additionalProperties: false,
        },
        readOnly: false,
        run: (args) => {
          if (Boolean(args.parent_page_id) === Boolean(args.database_id))
            throw new AppError(
              "invalid_argument",
              "Pass exactly one of parent_page_id or database_id.",
            );
          const database = args.database_id ? this.database(args.database_id) : undefined;
          const parent = args.parent_page_id
            ? this.editable(this.page(args.parent_page_id))
            : undefined;
          if (database?.access === "view")
            throw new AppError(
              "permission_denied",
              `This connection has view-only access to "${database.title}".`,
            );
          const values = (args.properties ?? {}) as Record<string, PropertyValue>;
          const titleProperty = database ? this.titleProperty(database) : "title";
          const props = { ...values, [titleProperty]: String(args.title) };
          if (database) this.validateProperties(database, props, "create_page");
          else if (Object.keys(values).length)
            throw new AppError(
              "invalid_argument",
              "Only database rows have properties; a child page takes a title.",
            );
          const id = noteId(this.nextId("created:"));
          const page: Page = {
            key: id,
            id,
            title: String(args.title),
            parentId: database?.id ?? parent!.id,
            properties: props,
            blocks: blocksFromText(String(args.content ?? "")).map((block, index) => ({
              ...block,
              id: noteId(`${id}:block:${index}`),
            })),
            edited: this.stamp(),
            editedBy: this.seed.member,
            created: this.stamp(),
          };
          this.pages.set(id, page);
          this.record({
            tool: "create_page",
            args,
            target: id,
            after: { ...this.row(page), blocks: page.blocks },
          });
          return this.summary(page);
        },
      },
      {
        name: "update_page_properties",
        description:
          "Set property values on a database row. Properties not named keep their values.",
        inputSchema: {
          type: "object",
          properties: { page_id: { type: "string" }, properties },
          required: ["page_id", "properties"],
          additionalProperties: false,
        },
        readOnly: false,
        run: (args) => {
          const page = this.editable(this.page(args.page_id));
          const database = page.parentId ? this.databases.get(page.parentId) : undefined;
          if (!database)
            throw new AppError(
              "invalid_argument",
              `"${page.title}" is not a database row; it has no properties to set.`,
            );
          const values = args.properties as Record<string, PropertyValue>;
          this.validateProperties(database, values, "update_page_properties");
          const before = structuredClone(page.properties);
          Object.assign(page.properties, values);
          page.title = String(page.properties[this.titleProperty(database)] ?? "");
          page.edited = this.stamp();
          page.editedBy = this.seed.member;
          this.record({
            tool: "update_page_properties",
            args,
            target: page.id,
            before,
            after: page.properties,
          });
          return this.row(page);
        },
      },
    ];
  }
}
