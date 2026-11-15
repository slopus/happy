import { gzipSync } from "node:zlib";

export interface TarEntry {
  name: string;
  content?: Uint8Array;
  mode?: number;
  /** The tar type flag: `0` file, `1` hard link, `2` symbolic link, `5` directory, `x` pax. */
  type?: string;
  /** Header size when it should differ from the content's, as a corrupt archive's would. */
  size?: number;
}

/** A tar block header with a valid checksum. */
export function tarHeader(entry: TarEntry): Buffer {
  const header = Buffer.alloc(512);
  const size = entry.size ?? entry.content?.byteLength ?? 0;
  header.write(entry.name, 0, 100, "utf8");
  header.write(`${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100, "latin1");
  header.write("0000000\0", 108, "latin1");
  header.write("0000000\0", 116, "latin1");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  header.write("00000000000\0", 136, "latin1");
  header.write(entry.type ?? "0", 156, "latin1");
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "latin1");
  header.write("        ", 148, "latin1");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return header;
}

/** One pax record: `<length> <key>=<value>\n`, where the length counts itself. */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bytes = Buffer.byteLength(body);
  let length = bytes + 1;
  while (String(length).length + bytes !== length) length = String(length).length + bytes;
  return `${length}${body}`;
}

/** Raw tar bytes for `entries`, each padded to whole blocks, ending in two zero blocks. */
export function tarBytes(entries: readonly TarEntry[], { end = true } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? new Uint8Array());
    parts.push(tarHeader(entry), content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  if (end) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/**
 * A gzipped pax tar of workspace files as the export's tar command writes it: names under `./`,
 * each behind an extended header carrying its full path, so long and non-ASCII names survive.
 */
export function workspaceArchive(
  files: Iterable<readonly [string, { content: Uint8Array; executable: boolean }]>,
): Buffer {
  const entries: TarEntry[] = [];
  for (const [relative, file] of files) {
    const name = `./${relative}`;
    entries.push(
      { name: "./PaxHeaders/file", type: "x", content: Buffer.from(paxRecord("path", name)) },
      {
        name: /^[\x20-\x7e]{1,99}$/.test(name) ? name : "./name-in-extended-header",
        content: file.content,
        mode: file.executable ? 0o755 : 0o644,
      },
    );
  }
  return gzipSync(tarBytes(entries));
}
