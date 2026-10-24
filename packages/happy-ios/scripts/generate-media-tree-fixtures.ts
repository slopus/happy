// Generates Tests/HappyCoreTests/Fixtures/media-layout-html.json from the
// reference TypeScript: @slopus/happy-agent-client's parseMediaLayoutHtml.
// The Swift port (StemCellMediaTree.parse) must build the same tree, place
// the same items and report the same truncation for every case.
//
//   bun scripts/generate-media-tree-fixtures.ts <happy-agent-client/sources>

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [clientDir] = process.argv.slice(2);
if (!clientDir) throw new Error("usage: generate-media-tree-fixtures.ts <client sources>");
const { parseMediaLayoutHtml } = await import(resolve(clientDir, "mediaLayoutHtml.ts"));

const sources: Record<string, number> = { "a.png": 0, "b.png": 1, "c.png": 2, "/abs/d.png": 3 };
const resolveSource = (src: string) => sources[src];

const hand = [
    '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">\n  <img src="a.png">\n  <img src="b.png">\n</div>\n',
    '<img src="a.png">',
    '<img src="a.png" alt="  the   first\nshot ">',
    '<figure style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px">\n  <img src="a.png"><img src="b.png"><img src="c.png">\n  <figcaption>Before &amp; after</figcaption>\n</figure>',
    '<div style="display:flex;flex-wrap:wrap;gap:12px"><img src="a.png" style="width: 200px"><img src="b.png" style="width:200px"></div>',
    '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax( 200px ,1fr )); gap: 8px 4px"><img src="a.png"><img src="/abs/d.png"></div>',
    '<section><p>One <strong>bold</strong> and <em>it</em> and <code>x</code></p><img src="a.png"></section>',
    '<div style="color: red; position: absolute; width: calc(100% - 8px); height: 120px">x<img src="a.png"></div>',
    "<div style='width: 50%'><img src='a.png'></div>",
    '<div style="padding: 8px 12px; margin: 0 auto; border-radius: 8px; tone: muted; font-size: large">Hi<br>there<img src="a.png"></div>',
    '<div><img src="a.png"><img src="a.png"><img src="missing.png"><img></div>',
    '<div><script>alert(1)</script><style>p{}</style><img src="a.png"><video src="a.png"></video></div>',
    '<div><table><tr><td><img src="a.png"></td></tr></table></div>',
    '<div><!-- note --><img src="a.png"></div>',
    '<p>para <div><img src="a.png"></div> after</p>',
    '<div><span>a</span> <span>b</span></div>',
    '<div style="display: flex"> <img src="a.png"> <img src="b.png"> </div>',
    '<div>\n  <p>one</p>\n  <p>two</p>\n</div>',
    '<div style="aspect-ratio: 16 / 9; object-fit: cover"><img src="a.png" style="object-fit: cover; width: 100%; height: 100%"></div>',
    '<div style="grid-column: span 2; grid-row: 1 / 3; order: -1; flex: 1 1 0"><img src="a.png"></div>',
    '<div style="font-weight: 700; font-style: italic; text-align: center; line-height: 1.5">Title<img src="a.png"></div>',
    '<DIV STYLE="DISPLAY: GRID; GRID-TEMPLATE-COLUMNS: 2FR 1FR"><IMG SRC="a.png"><IMG SRC="b.png"></DIV>',
    '<div style="width: 10px /* comment */; height: 20px">x<img src="a.png"></div>',
    '<div style="display: grid; grid-template-columns: minmax(0, 1fr) fit-content(200px) auto">x<img src="a.png"></div>',
    '<div data-x="1" class="c" id="i"><img src="a.png" width="10" height="10"></div>',
    '<div>&lt;tag&gt; &#169; &#xA9; &nbsp;x &unknown; &amp<img src="a.png"></div>',
    '<div><div><div><div><div><div><div><div><div><div><div><div><div><div><img src="a.png"></div></div></div></div></div></div></div></div></div></div></div></div></div></div>',
    '<div><img src="a.png"><p>Caption</p></div><p>more</p>',
    '<div><img src="a.png">',
    '<p>one<p>two<img src="a.png">',
    '<span style="display: block">s<img src="a.png"></span>',
    '<div style="gap: 8px; gap: 16px"><img src="a.png"></div>',
    '<div style="margin: -4px; padding: 5000px"><img src="a.png"></div>',
    '<div></br><img src="a.png"></p></div>',
    '<ul><li>one</li><li>two</li></ul><img src="a.png">',
    '<h1>Heading</h1><img src="a.png"><a href="x">link</a>',
    '<div style="display: none">hidden<img src="a.png"></div><img src="b.png">',
    `<div>${"word ".repeat(2000)}<img src="a.png"></div>`,
    `<div>${"<span>x</span>".repeat(600)}<img src="a.png"></div>`,
    `${"<div>".repeat(40)}<img src="a.png">${"</div>".repeat(40)}`,
];

let seed = 0x51ab2c;
const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const pieces = [
    "<div>", "</div>", '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">', '<div style="display: flex">',
    '<img src="a.png">', '<img src="b.png" alt="B">', '<img src="c.png" style="width: 50%">', "<p>", "</p>", "<figure>",
    "</figure>", "<figcaption>", "</figcaption>", "<span>", "</span>", "<strong>", "</strong>", "<em>", "</em>", "<br>",
    "Hello", " ", "\n  ", "world.", "&amp;", "<section>", "</section>", "<b>", "</b>", "<!-- c -->",
    "<i>", "</i>", "<a>", "</a>", "<code>", "</code>", "<li>", "<ul>", "</ul>", "<h2>", "</h2>", "<nobr>", "</nobr>",
    "<pre>", "</pre>", "<hr>", "</br>", '<span style="tone: accent">', "&copy", "&#x41;", "</em>", "</strong>",
    "<blockquote>", "</blockquote>", "<unknown-tag>", "</unknown-tag>", '<img src="/abs/d.png">', "<script>x</div></script>",
];
const generated: string[] = [];
for (let i = 0; i < 1500; i++) {
    let html = "";
    const count = 1 + Math.floor(random() * 16);
    for (let j = 0; j < count; j++) html += pick(pieces);
    generated.push(html);
}

const cases = [...hand, ...generated].map((html) => {
    const parsed = parseMediaLayoutHtml(html, resolveSource);
    return { html, root: parsed.root, placed: parsed.placed, truncated: parsed.truncated };
});
const out = resolve(import.meta.dir, "../Tests/HappyCoreTests/Fixtures/media-layout-html.json");
writeFileSync(out, JSON.stringify({ sources, cases }) + "\n");
console.log(`cases ${cases.length}`);
