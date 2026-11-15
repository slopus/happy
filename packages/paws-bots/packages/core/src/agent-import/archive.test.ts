import { crc32 } from "node:zlib";
import { deflateSync, gunzipSync, gzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { AgentImportArchiveErrorReason, AgentImportArchiveLimits } from "./index.js";
import {
  AGENT_IMPORT_ARCHIVE_LIMITS,
  AgentImportArchiveError,
  agentImportFolder,
  agentImportSkillFiles,
  chooseAgentImportFiles,
  openAgentImportArchive,
} from "./index.js";

const text = (value: string) => new TextEncoder().encode(value);

type ZipFile = {
  name: string;
  content?: string;
  deflate?: boolean;
  mode?: number;
  encrypted?: boolean;
  declaredSize?: number;
  crc?: number;
  localName?: string;
};

/** A minimal zip writer, so tests can craft entries real tools would never produce. */
function zip(files: ZipFile[], options: { zip64?: boolean } = {}): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = text(file.name);
    const localName = text(file.localName ?? file.name);
    const raw = text(file.content ?? "");
    const body = file.deflate ? deflateSync(raw) : raw;
    const local = new Uint8Array(30 + localName.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(6, file.encrypted ? 1 : 0, true);
    lv.setUint16(8, file.deflate ? 8 : 0, true);
    lv.setUint32(14, file.crc ?? crc32(raw), true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, file.declaredSize ?? raw.length, true);
    lv.setUint16(26, localName.length, true);
    local.set(localName, 30);
    local.set(body, 30 + localName.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(8, file.encrypted ? 1 : 0, true);
    cv.setUint16(10, file.deflate ? 8 : 0, true);
    cv.setUint32(16, file.crc ?? crc32(raw), true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, file.declaredSize ?? raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, ((file.mode ?? 0o100644) << 16) >>> 0, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directory = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, options.zip64 ? 0xffff : files.length, true);
  ev.setUint32(12, directory, true);
  ev.setUint32(16, offset, true);
  return join([...locals, ...centrals, end]);
}

type TarFile = { name: string; content?: string; type?: string; size?: number };

function tarHeader(name: string, size: number, type: string): Uint8Array {
  const block = new Uint8Array(512);
  block.set(text(name).subarray(0, 100), 0);
  block.set(text("0000644\0"), 100);
  block.set(text(`${size.toString(8).padStart(11, "0")}\0`), 124);
  block[156] = type.charCodeAt(0);
  block.set(text("ustar\x0000"), 257);
  block.fill(32, 148, 156);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.set(text(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return block;
}

/** A minimal tar.gz writer (ustar, with pax and GNU long-name records when asked). */
function tarGz(files: TarFile[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const file of files) {
    const body = text(file.content ?? "");
    parts.push(tarHeader(file.name, file.size ?? body.length, file.type ?? "0"));
    parts.push(body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  return gzipSync(join(parts));
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Reads what a folder upload would read from the same paths. */
async function read(
  data: Uint8Array,
  limits: AgentImportArchiveLimits = AGENT_IMPORT_ARCHIVE_LIMITS,
) {
  const archive = openAgentImportArchive(data, limits);
  const chosen = await chooseAgentImportFiles(archive.paths, archive.read, {
    includeSecrets: true,
    size: archive.size,
  });
  return {
    paths: archive.paths,
    files: new Map(chosen.entries.map((entry) => [entry.path, entry.content])),
  };
}

async function fails(run: () => Promise<unknown>, reason: AgentImportArchiveErrorReason) {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentImportArchiveError);
    expect((error as AgentImportArchiveError).reason).toBe(reason);
    return;
  }
  throw new Error("expected the archive to be refused");
}

const skill = "---\nname: notes\ndescription: Take notes\n---\n\nRun `scripts/save.sh`.\n";

describe("Hermes backup zip", () => {
  const backup = zip([
    { name: "SOUL.md", content: "Direct.\n", deflate: true },
    { name: "config.yaml", content: "model:\n  provider: openrouter\n" },
    { name: ".env", content: "OPENROUTER_API_KEY=placeholder-key\n" },
    { name: "memories/MEMORY.md", content: "Fact.\n", deflate: true },
    { name: "skills/notes/notes/SKILL.md", content: skill },
    { name: "skills/notes/notes/scripts/save.sh", content: "#!/bin/sh\n" },
    { name: "skills/.bundled_manifest", content: "arxiv:abc\n" },
    { name: "state.db", content: "binary" },
    { name: "sessions/today.md", content: "Private.\n" },
    { name: "plugins/", content: "" },
  ]);

  it("lists files under .hermes and reads only the ones an import uses", async () => {
    const { paths, files } = await read(backup);
    expect(paths).toContain(".hermes/state.db");
    expect([...files.keys()].sort()).toEqual([
      ".hermes/.env",
      ".hermes/SOUL.md",
      ".hermes/config.yaml",
      ".hermes/memories/MEMORY.md",
      ".hermes/skills/.bundled_manifest",
      ".hermes/skills/notes/notes/SKILL.md",
    ]);
    expect(files.get(".hermes/SOUL.md")).toBe("Direct.\n");
    expect(files.get(".hermes/memories/MEMORY.md")).toBe("Fact.\n");
  });

  it("names a skill's other files without reading them", async () => {
    const { paths } = await read(backup);
    expect(agentImportSkillFiles(paths, agentImportFolder(paths).files)).toEqual({
      "skills/notes/notes/SKILL.md": ["scripts/save.sh"],
    });
  });
});

describe("OpenClaw backup tar.gz", () => {
  const root = "2026-01-02T03-04-05-openclaw-backup";
  const home = `${root}/payload/posix/home/example/.openclaw`;
  const manifest = JSON.stringify({
    schemaVersion: 1,
    archiveRoot: root,
    paths: { stateDir: "/home/example/.openclaw", workspaceDirs: ["/home/example/work"] },
    assets: [
      { kind: "state", sourcePath: "/home/example/.openclaw", archivePath: `${home}` },
      {
        kind: "workspace",
        sourcePath: "/home/example/work",
        archivePath: "payload/posix/home/example/work",
      },
    ],
  });
  const backup = tarGz([
    { name: `${root}/`, type: "5" },
    { name: `${root}/manifest.json`, content: manifest },
    { name: `${home}/openclaw.json`, content: "{ agents: { defaults: {} } }" },
    { name: `${home}/openclaw.json.bak`, content: '{ "gateway": {} }' },
    { name: `${home}/config-journal-fingerprint.key`, content: "fingerprint" },
    { name: `${home}/credentials/notes.md`, content: "EXAMPLE_KEY=placeholder\n" },
    { name: `${home}/agents/main/agent/AGENTS.md`, content: "Agent state.\n" },
    { name: `${home}/state/openclaw.sqlite`, content: "binary" },
    { name: `${home}/skills/notes/SKILL.md`, content: skill },
    { name: `${root}/payload/posix/home/example/work/SOUL.md`, content: "Calm.\n" },
    {
      name: `${root}/payload/posix/home/example/work/.git/hooks/pre-commit.sample`,
      content: "#!/bin/sh\n",
    },
    { name: `${root}/payload/posix/home/example/work/link.md`, type: "2" },
    { name: `${root}/payload/posix/home/example/work/hard.md`, type: "1" },
    { name: `${root}/payload/posix/home/example/work/device.md`, type: "3" },
  ]);

  it("maps the state and workspace assets and reads only the import's files", async () => {
    const { paths, files } = await read(backup);
    expect(paths).not.toContain(".openclaw/workspace/link.md");
    expect(paths).not.toContain(".openclaw/workspace/hard.md");
    expect([...files.keys()].sort()).toEqual([
      ".openclaw/openclaw.json",
      ".openclaw/skills/notes/SKILL.md",
      ".openclaw/workspace/SOUL.md",
    ]);
    expect(files.get(".openclaw/workspace/SOUL.md")).toBe("Calm.\n");
  });

  it("accepts a standalone config asset alongside directory assets", async () => {
    const external = `${root}/payload/posix/etc/openclaw/include.json`;
    const withConfig = JSON.parse(manifest);
    withConfig.assets.push({ kind: "config", archivePath: external });
    const archive = tarGz([
      { name: `${root}/manifest.json`, content: JSON.stringify(withConfig) },
      { name: `${home}/openclaw.json`, content: "{}" },
      { name: `${root}/payload/posix/home/example/work/SOUL.md`, content: "Calm.\n" },
      { name: external, content: "{}" },
    ]);
    expect((await read(archive)).files.get(".openclaw/workspace/SOUL.md")).toBe("Calm.\n");
    const directoryConfig = tarGz([
      { name: `${root}/manifest.json`, content: JSON.stringify(withConfig) },
      { name: `${home}/openclaw.json`, content: "{}" },
      { name: `${root}/payload/posix/home/example/work/SOUL.md`, content: "Calm.\n" },
      { name: `${external}/child.json`, content: "{}" },
    ]);
    expect((await read(directoryConfig)).files.get(".openclaw/openclaw.json")).toBe("{}");
    await fails(() => read(archive, { ...AGENT_IMPORT_ARCHIVE_LIMITS, readBytes: 1 }), "too_large");
  });

  it("requires each declared asset and respects path boundaries and directory kinds", async () => {
    const base = `${root}/payload/posix/etc/openclaw/include.json`;
    const check = async (kind: string, declared: string, actual: string, type = "0") => {
      const assets = JSON.parse(manifest);
      assets.assets.push({ kind, archivePath: declared });
      await fails(
        () =>
          read(
            tarGz([
              { name: `${root}/manifest.json`, content: JSON.stringify(assets) },
              { name: `${home}/openclaw.json`, content: "{}" },
              { name: `${root}/payload/posix/home/example/work/SOUL.md`, content: "Calm.\n" },
              { name: actual, content: "{}", type },
            ]),
          ),
        "unreadable",
      );
    };
    await check("config", `${base}.missing`, base);
    await check("config", base, `${base}.other`);
    await check("config", base, base, "5");
    await check("config", base, base, "2");
    await check("config", `${root}/payload/../escape`, base);
    await check("credentials", base, base);
    await check("state", base, base);
    await check("workspace", base, base);
  });

  it("finds the home from openclaw.json when there is no manifest", async () => {
    const plain = tarGz([
      { name: "backup/home/.openclaw/openclaw.json", content: "{}" },
      { name: "backup/home/.openclaw/workspace/SOUL.md", content: "Calm.\n" },
      { name: "backup/elsewhere/SOUL.md", content: "Not this.\n" },
    ]);
    expect([...(await read(plain)).files.keys()].sort()).toEqual([
      ".openclaw/openclaw.json",
      ".openclaw/workspace/SOUL.md",
    ]);
  });

  it("reads pax and GNU long names", async () => {
    const long = `${"a".repeat(120)}/SOUL.md`;
    const pax = `${`${long.length + 10} path=${long}\n`.length + 0} path=${long}\n`;
    const named = tarGz([
      { name: "PaxHeader", type: "x", content: pax.replace(/^\d+/, String(pax.length)) },
      { name: "ignored", content: "Pax name.\n" },
      { name: "././@LongLink", type: "L", content: `${"b".repeat(120)}/USER.md\0` },
      { name: "ignored-too", content: "Long name.\n" },
    ]);
    expect((await read(named)).paths).toEqual([long, `${"b".repeat(120)}/USER.md`]);
  });
});

describe("unsafe archives", () => {
  it.each([
    "../SOUL.md",
    "workspace/../../SOUL.md",
    "/etc/SOUL.md",
    "C:/SOUL.md",
    "workspace\\SOUL.md",
  ])("refuses the entry path %j", async (name) => {
    await fails(() => read(zip([{ name, content: "x" }])), "unreadable");
    await fails(() => read(tarGz([{ name, content: "x" }])), "unreadable");
  });

  it("refuses a NUL inside a zip entry name (tar names end at the first NUL)", async () => {
    await fails(() => read(zip([{ name: "workspace/SO\0UL.md", content: "x" }])), "unreadable");
  });

  it("skips links, encrypted entries and archives inside", async () => {
    const { paths, files } = await read(
      zip([
        { name: "SOUL.md", content: "Direct.\n" },
        { name: "USER.md", content: "x", mode: 0o120777 },
        { name: "memories/MEMORY.md", content: "x", encrypted: true },
        { name: "skills/a/old.zip", content: "PK" },
      ]),
    );
    expect(paths).toEqual([".hermes/SOUL.md"]);
    expect([...files.keys()]).toEqual([".hermes/SOUL.md"]);
  });

  it("refuses unknown formats, ZIP64 and broken tar headers", async () => {
    await fails(() => read(text("not an archive")), "unreadable");
    await fails(
      () => read(zip([{ name: "SOUL.md", content: "x" }], { zip64: true })),
      "unreadable",
    );
    const broken = tarGz([{ name: "SOUL.md", content: "x" }]);
    await fails(() => read(gzipSync(text("x".repeat(1024)))), "unreadable");
    expect((await read(broken)).paths).toEqual([".hermes/SOUL.md"]);
  });

  it("refuses duplicate files, truncated streams and manifests that do not match", async () => {
    await fails(
      () =>
        read(
          zip([
            { name: "SOUL.md", content: "a" },
            { name: "./SOUL.md", content: "b" },
          ]),
        ),
      "unreadable",
    );
    const whole = tarGz([{ name: "SOUL.md", content: "x".repeat(600) }]);
    const raw = gunzipSync(whole).subarray(0, 700);
    await fails(() => read(gzipSync(raw)), "unreadable");
    const manifest = (archiveRoot: string, archivePath: string) =>
      JSON.stringify({
        schemaVersion: 1,
        archiveRoot,
        assets: [{ kind: "state", archivePath }],
      });
    await fails(
      () =>
        read(
          tarGz([
            { name: "b/manifest.json", content: manifest("b", "b/payload/posix/missing") },
            { name: "b/payload/posix/home/.openclaw/openclaw.json", content: "{}" },
          ]),
        ),
      "unreadable",
    );
    await fails(
      () =>
        read(
          tarGz([
            {
              name: "b/manifest.json",
              content: manifest("other", "b/payload/posix/home/.openclaw"),
            },
            { name: "b/payload/posix/home/.openclaw/openclaw.json", content: "{}" },
          ]),
        ),
      "unreadable",
    );
  });

  it("stops at the caps", async () => {
    const small = {
      ...AGENT_IMPORT_ARCHIVE_LIMITS,
      entries: 2,
      fileBytes: 64,
      inflatedBytes: 4096,
    };
    const three = [1, 2, 3].map((n) => ({ name: `memory/${n}.md`, content: "x" }));
    await fails(() => read(zip(three), small), "too_large");
    await fails(() => read(tarGz(three), small), "too_large");
    await fails(
      () => read(zip([{ name: "SOUL.md", content: "x".repeat(100) }]), small),
      "too_large",
    );
    await fails(
      () => read(tarGz([{ name: "SOUL.md", content: "x".repeat(100) }]), small),
      "too_large",
    );
    // A gzip bomb: little input, far more output than allowed.
    await fails(
      () => read(tarGz([{ name: "a.bin", content: "\0".repeat(8192) }]), small),
      "too_large",
    );
    // A zip entry claiming a size far past its compression ratio.
    const bomb = zip([{ name: "SOUL.md", content: "x".repeat(2 * 1024 * 1024), deflate: true }]);
    await fails(
      () => read(bomb, { ...AGENT_IMPORT_ARCHIVE_LIMITS, fileBytes: 4 * 1024 * 1024, ratio: 2 }),
      "too_large",
    );
  });

  it("stops keeping tar data at the memory cap, below the inflate and ratio caps", async () => {
    // Many small files an import would read, varied so they barely compress.
    const many = Array.from({ length: 40 }, (_, n) => ({
      name: `memory/2026-01-${String(n).padStart(2, "0")}.md`,
      content: Array.from(
        { length: 64 },
        (_, line) => `${n}-${line}-${(n * 7919 + line * 104729) % 1000003}`,
      ).join("\n"),
    }));
    const archive = tarGz(many);
    const budget = { ...AGENT_IMPORT_ARCHIVE_LIMITS, retainedBytes: 16 * 1024 };
    expect(gunzipSync(archive).length).toBeLessThan(budget.inflatedBytes);
    // Opening the archive is enough: the stream stops before buffering past the cap.
    await fails(async () => openAgentImportArchive(archive, budget), "too_large");
    // Files no import reads are listed, never kept, so they do not count.
    const docs = tarGz(
      many.map((file) => ({
        ...file,
        name: `skills/a/references/${file.name.replace("memory/", "notes-")}`,
      })),
    );
    expect(() => openAgentImportArchive(docs, budget)).not.toThrow();
  });

  it("charges only the agent's own files against the read budget", async () => {
    const others = Array.from({ length: 40 }, (_, n) => ({
      name: `other/memory/${n}.md`,
      content: `${n}`.repeat(1024),
    }));
    const backup = tarGz([
      { name: "home/openclaw.json", content: "{}" },
      { name: "home/workspace/SOUL.md", content: "Calm.\n" },
      ...others,
    ]);
    const budget = { ...AGENT_IMPORT_ARCHIVE_LIMITS, readBytes: 16 * 1024 };
    const { files } = await read(backup, budget);
    expect(files.get(".openclaw/workspace/SOUL.md")).toBe("Calm.\n");
  });
});

describe("malformed archives", () => {
  const entry = { name: "SOUL.md", content: "Direct.\n" };

  it("refuses a zip whose stored checksum, size or local name disagrees", async () => {
    await fails(() => read(zip([{ ...entry, crc: 1 }])), "unreadable");
    await fails(() => read(zip([{ ...entry, deflate: true, declaredSize: 3 }])), "unreadable");
    await fails(() => read(zip([{ ...entry, localName: "USER.md" }])), "unreadable");
  });

  it("refuses a zip whose central directory, or a record in it, runs past its end", async () => {
    const longer = zip([entry]);
    const view = new DataView(longer.buffer, longer.byteOffset, longer.byteLength);
    const end = longer.length - 22;
    view.setUint32(end + 12, view.getUint32(end + 12, true) + 10, true);
    await fails(async () => openAgentImportArchive(longer), "unreadable");

    const record = zip([entry]);
    const recordView = new DataView(record.buffer, record.byteOffset, record.byteLength);
    const directory = recordView.getUint32(record.length - 22 + 16, true);
    recordView.setUint16(directory + 32, 200, true);
    await fails(async () => openAgentImportArchive(record), "unreadable");
  });

  it("refuses tar sizes that are not strict octal, bad pax records and a missing end", async () => {
    const tar = (header: Uint8Array, body = "") =>
      gzipSync(join([header, text(body.padEnd(512, "\0")), new Uint8Array(1024)]));
    const header = tarHeader("SOUL.md", 7, "0");
    header.set(text("0000000007x\0"), 124);
    header.fill(32, 148, 156);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.set(text(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    await fails(() => read(tar(header, "Direct.")), "unreadable");

    const pax = "99 path=SOUL.md\n";
    await fails(
      () =>
        read(
          tarGz([
            { name: "PaxHeader", type: "x", content: pax },
            { name: "x", content: "Direct.\n" },
          ]),
        ),
      "unreadable",
    );

    const raw = gunzipSync(tarGz([entry]));
    await fails(() => read(gzipSync(raw.subarray(0, raw.length - 1024))), "unreadable");
  });
});

describe("reading the same files again", () => {
  it("counts each file once, so turning API keys on and off never makes a backup too large", () => {
    // About 3 MB that an import reads: four memory files under the 1 MB file limit.
    const line = "Notes about the garden and the weekly plan.\n";
    const memory = Array.from({ length: 4 }, (_, n) => ({
      name: `memories/note-${n}.md`,
      content: line.repeat(Math.floor((750 * 1024) / line.length)),
    }));
    const archive = openAgentImportArchive(
      zip([{ name: "SOUL.md", content: "Calm.\n" }, ...memory]),
    );
    const chosen = archive.paths.filter((path) => path.includes("memories/"));
    const total = chosen.reduce((sum, path) => sum + (archive.size(path) ?? 0), 0);
    expect(total).toBeGreaterThan(2.9 * 1024 * 1024);
    // Three reads of the same choice: more than the read budget if each one were counted.
    for (let pass = 0; pass < 3; pass++) {
      for (const path of chosen) expect(archive.read(path).length).toBe(memory[0]!.content.length);
    }
    expect(3 * total).toBeGreaterThan(AGENT_IMPORT_ARCHIVE_LIMITS.readBytes);
  });
});
