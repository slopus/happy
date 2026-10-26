// Generates Tests/HappyCoreTests/Fixtures/happy-references.json from the
// reference TypeScript: @slopus/happy-agent-client's parseHappyReferences.
// The Swift port (HappyReferences.parse) must reproduce every case, settled
// and streaming.
//
//   bun scripts/generate-reference-fixtures.ts <happy-agent-client/sources>

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [clientDir] = process.argv.slice(2);
if (!clientDir) throw new Error("usage: generate-reference-fixtures.ts <client sources>");
const { parseHappyReferences } = await import(resolve(clientDir, "index.ts"));

let seed = 0x4a17c3;
const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

const hand = [
    'Started <happy-agent id="cgvdjiq0ev75u6kulqin7bim"/> to draft it.',
    'See <happy-artifact id="a1" version="2"/> and <happy-surface id="s_1"/>.',
    '<happy-service id="web" workspace="w-2"/>',
    '<happy-agent id="x" id="y"/>',
    '<happy-agent id="bad id"/>',
    '<happy-artifact id="a" version="0"/>',
    '<happy-Agent id="a"/>',
    '<happy-agent  id="a"  />',
    "`<happy-agent id=\"a\"/>` and <happy-agent id=\"b\"/>",
    "```\n<happy-agent id=\"a\"/>\n```\n<happy-agent id=\"b\"/>",
    "> ```\n<happy-agent id=\"a\"/>\n> ```\n<happy-agent id=\"b\"/>",
    "\\<happy-agent id=\"a\"/>",
    "text <happy-agen",
    "text <happy-agent id=\"abc",
    "text <happy-agent id=\"abc\"",
    "text <happy-agent id=\"abc\" /",
    "text <",
    "text <h",
    "text <happy-",
    "a `code <happy-agent id=\"a\"/>",
    "~~~\n<happy-agent id=\"a\"/>\n~~~~\nafter <happy-agent id=\"b\"/>",
    "🙂 <happy-agent id=\"é\"/> <happy-agent id=\"ok\"/> 🙂",
    "<happy-x-y id=\"a\"/> <happy-x- id=\"a\"/>",
];

const pieces = [
    "Hello world.", "\n", "\n\n", " ", "`", "``", "```", "~~~", "\\", "<", "<happy-", "<happy-agent", " id=\"a1\"",
    " id=\"b_2\"", " version=\"3\"", " workspace=\"w\"", "/>", " />", "\"", "<happy-agent id=\"q\"/>",
    "<happy-artifact id=\"r\" version=\"12\"/>", "<happy-surface id=\"s\"/>", "> ", "- ", "é", "🙂", "\t",
];
const generated: string[] = [];
for (let i = 0; i < 400; i++) {
    let text = "";
    const count = 1 + Math.floor(random() * 12);
    for (let j = 0; j < count; j++) text += pick(pieces);
    generated.push(text);
}

const cases = [...hand, ...generated].map((text) => ({
    text,
    settled: parseHappyReferences(text),
    streaming: parseHappyReferences(text, { streaming: true }),
}));
const out = resolve(import.meta.dir, "../Tests/HappyCoreTests/Fixtures/happy-references.json");
writeFileSync(out, JSON.stringify({ cases }) + "\n");
console.log(`cases ${cases.length}`);
