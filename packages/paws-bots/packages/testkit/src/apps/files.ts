import type { AppEmulatorOptions, AppTool } from "./app-emulator.js";
import { AppEmulator, AppError, paginate, queryTerms, stableId } from "./app-emulator.js";

export type FileKind = "folder" | "document" | "spreadsheet" | "pdf";
/** The account's access: `none` is a file it knows of (say, from a link) but cannot open. */
export type FileAccess = "owner" | "writer" | "commenter" | "reader" | "none";
export type Sheet = { name: string; rows: string[][] };
export type FileSeed = {
  /** Stable key; the file id derives from it (see fileId). */
  key: string;
  name: string;
  kind: FileKind;
  /** Parent folder key; omitted for the top of My files. */
  parent?: string;
  owner: string;
  access: FileAccess;
  modified: string;
  modifiedBy?: string;
  sharedWith?: Array<{ email: string; role: "writer" | "commenter" | "reader" }>;
  linkSharing?: "restricted" | "domain" | "anyone";
  description?: string;
  /** Text of a document or PDF. */
  content?: string;
  sheets?: Sheet[];
  starred?: boolean;
  trashed?: boolean;
};
export type FilesSeed = {
  account: { name: string; email: string };
  /** Base of the links the service hands out, e.g. https://files.example.com */
  baseUrl: string;
  files: FileSeed[];
};

type StoredFile = Omit<FileSeed, "parent" | "sharedWith"> & {
  id: string;
  parent: string | null;
  sharedWith: NonNullable<FileSeed["sharedWith"]>;
  version: number;
  created: string;
};

const MIME: Record<FileKind, string> = {
  folder: "application/vnd.folder",
  document: "application/vnd.document",
  spreadsheet: "application/vnd.spreadsheet",
  pdf: "application/pdf",
};
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A 28-character opaque id like file storage services issue, stable for a seed key. */
export function fileId(key: string) {
  const hex = stableId(`file:${key}`, 48);
  let id = "1";
  for (let i = 0; i < 27; i++) id += BASE62[Number.parseInt(hex.slice(i, i + 2), 16) % 62];
  return id;
}

const canRead = (access: FileAccess) => access !== "none";
const canWrite = (access: FileAccess) => access === "owner" || access === "writer";

/**
 * File storage: nested folders, documents, spreadsheets and PDFs with content, full-text search,
 * sharing metadata, pagination, and permission errors for files the account cannot open or edit.
 */
export class FilesEmulator extends AppEmulator {
  readonly kind = "files";
  readonly displayName = "Files";
  readonly account: FilesSeed["account"];
  readonly files = new Map<string, StoredFile>();
  private readonly baseUrl: string;

  constructor(seed: FilesSeed, options: AppEmulatorOptions) {
    super(options);
    this.account = seed.account;
    this.baseUrl = seed.baseUrl.replace(/\/$/, "");
    for (const file of seed.files) {
      const id = fileId(file.key);
      this.files.set(id, {
        ...file,
        id,
        parent: file.parent ? fileId(file.parent) : null,
        sharedWith: file.sharedWith ?? [],
        version: 1,
        created: file.modified,
      });
    }
    for (const file of this.files.values())
      if (file.parent && this.files.get(file.parent)?.kind !== "folder")
        throw new Error(`Seed file ${file.key} has no folder ${file.parent}`);
  }

  url(file: StoredFile) {
    const path =
      file.kind === "folder" ? "folders" : file.kind === "spreadsheet" ? "sheets/d" : "d";
    return `${this.baseUrl}/${path}/${file.id}`;
  }

  private path(file: StoredFile): string {
    const names: string[] = [];
    let parent = file.parent ? this.files.get(file.parent) : undefined;
    while (parent) {
      names.unshift(parent.name);
      parent = parent.parent ? this.files.get(parent.parent) : undefined;
    }
    return `/${["My files", ...names].join("/")}`;
  }

  /** Find a file by id or by a link to it; a file the account cannot see reads as missing. */
  private file(idOrUrl: unknown) {
    const raw = String(idOrUrl ?? "");
    const id = raw.match(/\/(?:d|folders|sheets\/d)\/([A-Za-z0-9_-]+)/)?.[1] ?? raw;
    const file = this.files.get(id);
    if (!file || file.trashed) throw new AppError("not_found", `File not found: ${id}`);
    return file;
  }

  private readable(idOrUrl: unknown) {
    const file = this.file(idOrUrl);
    if (!canRead(file.access))
      throw new AppError(
        "permission_denied",
        `You need access to this file. Ask the owner (${file.owner}) to share it with ${this.account.email}.`,
      );
    return file;
  }

  private writable(idOrUrl: unknown) {
    const file = this.readable(idOrUrl);
    if (!canWrite(file.access))
      throw new AppError(
        "permission_denied",
        `You have ${file.access} access to "${file.name}". Ask the owner (${file.owner}) for edit access.`,
      );
    return file;
  }

  private folder(idOrUrl: unknown) {
    if (idOrUrl === undefined || idOrUrl === null || idOrUrl === "" || idOrUrl === "root")
      return null;
    const folder = this.readable(idOrUrl);
    if (folder.kind !== "folder")
      throw new AppError("invalid_argument", `${folder.name} is not a folder.`);
    return folder;
  }

  private listing(file: StoredFile) {
    return {
      id: file.id,
      name: file.name,
      type: file.kind,
      mime_type: MIME[file.kind],
      path: this.path(file),
      owner: file.owner,
      modified_time: file.modified,
      ...(file.modifiedBy ? { last_modified_by: file.modifiedBy } : {}),
      web_url: this.url(file),
      shared: file.sharedWith.length > 0 || (file.linkSharing ?? "restricted") !== "restricted",
      ...(file.starred ? { starred: true } : {}),
    };
  }

  private visible() {
    return [...this.files.values()].filter((file) => !file.trashed && canRead(file.access));
  }

  private text(file: StoredFile) {
    return [
      file.name,
      file.description ?? "",
      file.content ?? "",
      ...(file.sheets ?? []).flatMap((s) => s.rows.flat()),
    ]
      .join("\n")
      .toLowerCase();
  }

  tools(): AppTool[] {
    const page = { type: "integer", description: "Results per page, 1-100. Default 20." };
    const token = { type: "string", description: "next_page_token from a previous page." };
    return [
      {
        name: "search_files",
        description:
          'Full-text search across file names and contents the account can open. Words must all match; use "quotes" for a phrase and -word to exclude. Filter by type, folder, owner or modification date. Name matches rank first, then most recently modified.',
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            type: {
              type: "string",
              enum: ["folder", "document", "spreadsheet", "pdf"],
            },
            folder_id: { type: "string", description: "Only direct children of this folder." },
            owner: { type: "string", description: "Owner email address." },
            modified_after: { type: "string", description: "ISO 8601 date or time." },
            page_size: page,
            page_token: token,
          },
          additionalProperties: false,
        },
        readOnly: true,
        run: (args) => {
          const terms = queryTerms(String(args.query ?? ""));
          const operator = terms.find((term) => term.key || term.or);
          if (operator)
            throw new AppError(
              "invalid_argument",
              `Unsupported search operator: ${operator.key ? `${operator.key}:` : "OR"}. Filter with the type, folder_id, owner and modified_after arguments.`,
            );
          const folder = args.folder_id ? this.folder(args.folder_id) : undefined;
          const matched = this.visible()
            .filter((file) => {
              if (args.type && file.kind !== args.type) return false;
              if (folder !== undefined && file.parent !== (folder?.id ?? null)) return false;
              if (args.owner && file.owner.toLowerCase() !== String(args.owner).toLowerCase())
                return false;
              if (args.modified_after && file.modified < String(args.modified_after)) return false;
              const text = this.text(file);
              return terms.every((term) => text.includes(term.text) !== term.negate);
            })
            .map((file) => ({
              file,
              byName: terms.some((t) => !t.negate && file.name.toLowerCase().includes(t.text)),
            }))
            .sort(
              (a, b) =>
                Number(b.byName) - Number(a.byName) ||
                b.file.modified.localeCompare(a.file.modified),
            )
            .map(({ file }) => file);
          const { page: files, next } = paginate(matched, {
            size: args.page_size,
            token: args.page_token,
            scope: `search:${JSON.stringify({ ...args, page_token: undefined, page_size: undefined })}`,
            fallback: 20,
            max: 100,
          });
          return { files: files.map((file) => this.listing(file)), next_page_token: next };
        },
      },
      {
        name: "list_folder",
        description:
          'List a folder\'s contents, folders first. Omit folder_id (or pass "root") for the top of My files.',
        inputSchema: {
          type: "object",
          properties: {
            folder_id: { type: "string" },
            order_by: { type: "string", enum: ["name", "modified"] },
            page_size: page,
            page_token: token,
          },
          additionalProperties: false,
        },
        readOnly: true,
        run: (args) => {
          const folder = this.folder(args.folder_id);
          const children = this.visible()
            .filter((file) => file.parent === (folder?.id ?? null))
            .sort(
              (a, b) =>
                Number(b.kind === "folder") - Number(a.kind === "folder") ||
                (args.order_by === "modified"
                  ? b.modified.localeCompare(a.modified)
                  : a.name.localeCompare(b.name)),
            );
          const { page: files, next } = paginate(children, {
            size: args.page_size,
            token: args.page_token,
            scope: `folder:${folder?.id ?? "root"}:${String(args.order_by ?? "name")}`,
            fallback: 20,
            max: 100,
          });
          return {
            folder: folder
              ? this.listing(folder)
              : { id: "root", name: "My files", path: "/My files" },
            files: files.map((file) => this.listing(file)),
            next_page_token: next,
          };
        },
      },
      {
        name: "get_file_metadata",
        description:
          "Get a file's details: owner, sharing, permissions, your capabilities and version. Accepts an id or a link.",
        inputSchema: {
          type: "object",
          properties: { file_id: { type: "string", description: "File id or link." } },
          required: ["file_id"],
          additionalProperties: false,
        },
        readOnly: true,
        run: (args) => {
          const file = this.readable(args.file_id);
          return {
            ...this.listing(file),
            created_time: file.created,
            version: file.version,
            ...(file.description ? { description: file.description } : {}),
            link_sharing: file.linkSharing ?? "restricted",
            permissions: [
              { email: file.owner, role: "owner" },
              ...file.sharedWith,
              ...(file.owner === this.account.email ||
              file.sharedWith.some((s) => s.email === this.account.email)
                ? []
                : [{ email: this.account.email, role: file.access }]),
            ],
            capabilities: {
              can_edit: canWrite(file.access),
              can_comment: canWrite(file.access) || file.access === "commenter",
              can_share: canWrite(file.access),
            },
          };
        },
      },
      {
        name: "read_file",
        description:
          "Read a file's content. Documents and PDFs return text; spreadsheets return rows per sheet (pass sheet to read one). Accepts an id or a link.",
        inputSchema: {
          type: "object",
          properties: {
            file_id: { type: "string", description: "File id or link." },
            sheet: { type: "string" },
          },
          required: ["file_id"],
          additionalProperties: false,
        },
        readOnly: true,
        run: (args) => {
          const file = this.readable(args.file_id);
          if (file.kind === "folder")
            throw new AppError("invalid_argument", `${file.name} is a folder; use list_folder.`);
          const base = {
            id: file.id,
            name: file.name,
            type: file.kind,
            version: file.version,
            modified_time: file.modified,
          };
          if (file.kind !== "spreadsheet") return { ...base, content: file.content ?? "" };
          const sheets = file.sheets ?? [];
          const chosen = args.sheet ? sheets.filter((s) => s.name === args.sheet) : sheets;
          if (args.sheet && !chosen.length)
            throw new AppError(
              "not_found",
              `No sheet named ${String(args.sheet)}. Sheets: ${sheets.map((s) => s.name).join(", ")}`,
            );
          return {
            ...base,
            sheets: chosen.map((s) => ({ name: s.name, row_count: s.rows.length, rows: s.rows })),
          };
        },
      },
      {
        name: "share_file",
        description: "Share a file with someone by email as reader, commenter or writer.",
        inputSchema: {
          type: "object",
          properties: {
            file_id: { type: "string" },
            email: { type: "string" },
            role: { type: "string", enum: ["reader", "commenter", "writer"] },
            notify: { type: "boolean", description: "Email them a notification. Default true." },
          },
          required: ["file_id", "email", "role"],
          additionalProperties: false,
        },
        readOnly: false,
        run: (args) => {
          const file = this.writable(args.file_id);
          const email = String(args.email).toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            throw new AppError("invalid_argument", `Invalid email address: ${email}`);
          const before = structuredClone(file.sharedWith);
          file.sharedWith = [
            ...file.sharedWith.filter((s) => s.email !== email),
            { email, role: args.role as "reader" | "commenter" | "writer" },
          ];
          this.record({
            tool: "share_file",
            args,
            target: file.id,
            before,
            after: file.sharedWith,
          });
          return { id: file.id, permissions: file.sharedWith };
        },
      },
    ];
  }
}
