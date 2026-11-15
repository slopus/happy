import type { AccountExportManifest, AccountExportRecord } from "@rakazo/contracts";
import { accountExportPaths } from "@rakazo/contracts";
import { Zip, ZipDeflate } from "fflate";

export type ArchiveFile = [name: string, content: string | Uint8Array];

/**
 * Deterministic incompressible bytes (SplitMix64). A linear congruential
 * generator is not enough here: fflate's deflate finds structure in its
 * output and compresses it, so a nested zip built from it never leaks its
 * inner headers into the outer stream.
 */
export function incompressibleBytes(size: number, seed = 0x12345678n): Uint8Array {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let state = BigInt(seed);
  for (let offset = 0; offset < size; offset += 8) {
    state = (state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    let value = state;
    value = ((value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
    value = ((value ^ (value >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
    value ^= value >> 31n;
    view.setBigUint64(offset, value, true);
  }
  return bytes;
}

/** Streams entries the way the exporter does, so data descriptors are exercised too. */
export function buildArchive(files: ArchiveFile[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  for (const [name, content] of files) {
    const entry = new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    entry.push(typeof content === "string" ? new TextEncoder().encode(content) : content, true);
  }
  zip.end();
  return Buffer.concat(chunks);
}

export function exportFiles(
  manifest: AccountExportManifest,
  spaces: Array<{
    id: string;
    records: AccountExportRecord[];
    artifacts?: Array<[id: string, content: string | Uint8Array]>;
    homes?: Array<[botId: string, path: string, content: string | Uint8Array]>;
    executables?: Array<{ botId: string; path: string }>;
  }>,
): ArchiveFile[] {
  return [
    ["manifest.json", JSON.stringify(manifest)],
    ...spaces.flatMap((space): ArchiveFile[] => [
      [
        accountExportPaths.records(space.id),
        space.records.map((record) => `${JSON.stringify(record)}\n`).join(""),
      ],
      ...(space.artifacts ?? []).map(
        ([id, content]): ArchiveFile => [accountExportPaths.artifact(space.id, id), content],
      ),
      ...(space.homes ?? []).map(
        ([botId, path, content]): ArchiveFile => [
          accountExportPaths.homeFile(space.id, botId, path),
          content,
        ],
      ),
      ...(space.executables
        ? [
            [
              accountExportPaths.executables(space.id),
              JSON.stringify(space.executables),
            ] as ArchiveFile,
          ]
        : []),
    ]),
  ];
}

export function manifestFor(spaces: Array<{ id: string; name: string }>): AccountExportManifest {
  return {
    format: "rakazo-account-export",
    version: 1,
    exportedAt: "2026-10-01T00:00:00.000Z",
    user: { name: "Ada", email: "ada@example.com", timezone: "UTC" },
    spaces: spaces.map((space) => ({ ...space, createdAt: "2026-01-01T00:00:00.000Z" })),
  };
}

export async function* chunked(bytes: Uint8Array, size = 7_001): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size)
    yield bytes.subarray(offset, offset + size);
}
