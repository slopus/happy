// Generates Tests/HappyCoreTests/Fixtures/media-layout-blocks.json from the
// reference TypeScript: @slopus/happy-agent-client's splitMediaLayoutBlocks.
// The Swift port (StemCellMediaBlocks.split) must reproduce every case.
//
//   bun scripts/generate-media-block-fixtures.ts <happy-agent-client/sources>

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [clientDir] = process.argv.slice(2);
if (!clientDir) throw new Error("usage: generate-media-block-fixtures.ts <client sources>");
const { splitMediaLayoutBlocks } = await import(resolve(clientDir, "index.ts"));

let seed = 0x6d3d1a;
const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

const hand = [
    "Side by side:\n\n<div style=\"display: grid; grid-template-columns: 1fr 1fr; gap: 8px\">\n  <img src=\"shots/before.png\">\n  <img src=\"shots/after.png\">\n</div>\n\nDone.",
    "<img src=\"a.png\">",
    "<img src=\"a.png\" alt=\"x > y\"> trailing words\nnext",
    "<div>\n\nno image here\n\n</div>\ntext",
    "<div><div><img src=\"a\"></div>\n\n</div>",
    "<div style='gap: 8px'><img src='a'>",
    "text\n<di",
    "text\n<",
    "text\n<span>",
    "```\n<div><img src=\"a\"></div>\n```\n<p><img src=\"b\"></p>",
    "`<div><img src=\"a\"></div>`",
    "a `code\n<div><img src=\"a\"></div>` b",
    "    <div><img src=\"a\"></div>",
    "   <FIGURE><IMG SRC=\"a\"><figcaption>Cap</figcaption></FIGURE>",
    "<div><!-- <div> --><img src=\"a\"></div>",
    "<div><!-- open",
    "<p>one</p><p>two</p>\n<p><img src=\"x\"></p>",
    "> ```\n<div><img src=\"a\"></div>\n> ```",
    "<section data-x=\"a>b\"><img src=\"🙂.png\"></section> 🙂",
    "~~~\n<div><img src=\"a\"></div>\n~~~~\nafter <div><img src=\"b\"></div>",
];

const pieces = [
    "Hello world.", "\n", "\n\n", "  ", "`", "``", "```", "~~~", "<div>", "</div>", "<div style=\"display: flex\">",
    "<img src=\"a.png\">", "<img src='b.png' alt='>'>", "<p>", "</p>", "<figure>", "</figure>", "<figcaption>Cap</figcaption>",
    "<section>", "</section>", "<!--", "-->", "<span>", "</span>", "<br>", "\\`", "> ", "- item", "<IMG SRC=c>", "<di", "<", "é",
    "🙂", "<div/>", "<img/>", "   ", "\t",
];
const generated: string[] = [];
for (let i = 0; i < 400; i++) {
    let text = "";
    const count = 1 + Math.floor(random() * 14);
    for (let j = 0; j < count; j++) text += pick(pieces);
    generated.push(text);
}

const cases = [...hand, ...generated].map((text) => ({ text, segments: splitMediaLayoutBlocks(text) }));
const out = resolve(import.meta.dir, "../Tests/HappyCoreTests/Fixtures/media-layout-blocks.json");
writeFileSync(out, JSON.stringify({ cases }) + "\n");
console.log(`cases ${cases.length}`);
