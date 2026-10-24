// Generates Tests/HappyCoreTests/Fixtures/space-sidebar-vectors.json from the
// reference TypeScript: @slopus/happy-agent-client's sidebar parser,
// serializer, applier and differ, and desktop's document edits
// (happy-desktop-state/src/spaces/spacesSidebarDocument.ts). The Swift port
// must reproduce every case byte for byte.
//
//   bun scripts/generate-sidebar-fixtures.ts <happy-agent-client/sources> <desktop spacesSidebarDocument.ts>
//
// The desktop file imports "@slopus/happy-agent-client"; point that import at
// the client sources before running (see the README note in the fixture).

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [clientDir, desktopFile] = process.argv.slice(2);
if (!clientDir || !desktopFile) throw new Error("usage: generate-sidebar-fixtures.ts <client sources> <desktop edits>");
const client = await import(resolve(clientDir, "index.ts"));
const desktop = await import(resolve(desktopFile));
const { parseSpaceSidebar, formatSpaceSidebar, applySpaceSidebarOperations, diffSpaceSidebar } = client;

let seed = 0x5eed;
const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const chance = (p: number) => random() < p;

const error = (e: unknown) => {
    const value = e as { message: string; diagnostics?: { offset: number }[]; operationIndex?: number };
    if (value.diagnostics === undefined) throw e;
    return { message: value.message, offset: value.diagnostics[0]!.offset, operationIndex: value.operationIndex ?? null };
};

// Documents.
let counter = 0;
const fresh = (prefix: string) => `${prefix}${(counter++).toString(36)}`;
const labels = ["Bots", "Tasks", "Releases & \"ships\"", "<Ops>", "Distractions", " spaced ", "Ünïcode ✨", "a"];
function randomSpace(depth: number): any {
    const children = depth < 4 && chance(0.3) ? Array.from({ length: 1 + Math.floor(random() * 3) }, () => randomSpace(depth + 1)) : [];
    return {
        type: "space",
        id: fresh(depth === 0 ? "s" : "a"),
        expanded: chance(0.5),
        ...(chance(0.15) ? { foldRibbon: pick(["hover", "always"]) } : {}),
        children,
    };
}
function randomDocument(): any {
    const items: any[] = [{ type: "search", id: "happy-search" }, { type: "create", id: "happy-create" }];
    const count = 2 + Math.floor(random() * 8);
    for (let i = 0; i < count; i++) {
        const roll = random();
        if (roll < 0.55) items.push(randomSpace(0));
        else if (roll < 0.78) items.push({ type: "section", id: fresh("c"), label: pick(labels), collapsed: chance(0.3) });
        else if (roll < 0.92) items.push({ type: "separator", id: fresh("d") });
        else items.push({ type: "widget", id: fresh("w"), html: pick(["", "<b>hi</b>", "<div class=\"x\">\n  & raw</div>"]) });
    }
    // Search and Create anywhere.
    for (const _ of [0, 1]) {
        const from = Math.floor(random() * items.length);
        const [item] = items.splice(from, 1);
        items.splice(Math.floor(random() * (items.length + 1)), 0, item);
    }
    return { ...(chance(0.15) ? { foldRibbon: pick(["hover", "always"]) } : {}), items };
}
function allIds(document: any): string[] {
    const ids: string[] = [];
    const walk = (node: any) => {
        ids.push(node.id);
        if (node.type === "space") node.children.forEach(walk);
    };
    document.items.forEach(walk);
    return ids;
}
function randomPosition(document: any): any {
    const ids = allIds(document);
    const roll = random();
    if (roll < 0.15) return { parent: null };
    if (roll < 0.35) return { parent: chance(0.85) ? pick(ids) : fresh("gone") };
    return { after: chance(0.9) ? pick(ids) : chance(0.5) ? "nav" : fresh("gone") };
}
function randomOperation(document: any): any {
    const ids = [...allIds(document), "nav"];
    const roll = random();
    if (roll < 0.25) {
        const kind = pick(["space", "space", "section", "separator", "widget"]);
        const id = chance(0.9) ? fresh("n") : pick(ids);
        const node =
            kind === "space"
                ? { type: "space", id, ...(chance(0.4) ? { expanded: chance(0.5) } : {}), ...(chance(0.1) ? { foldRibbon: "always" } : {}) }
                : kind === "section"
                  ? { type: "section", id, label: pick(labels), ...(chance(0.3) ? { collapsed: chance(0.5) } : {}) }
                  : kind === "separator"
                    ? { type: "separator", id }
                    : { type: "widget", id, html: pick(["", "<i>x</i>", "</happy-widget>"]) };
        return { type: "insert", node, to: randomPosition(document) };
    }
    if (roll < 0.6) return { type: "move", id: chance(0.92) ? pick(ids) : fresh("gone"), to: randomPosition(document) };
    if (roll < 0.72) return { type: "remove", id: chance(0.9) ? pick(ids) : fresh("gone") };
    const fields: any = {};
    const field = pick(["label", "collapsed", "expanded", "foldRibbon", "html", "none"]);
    if (field === "label") fields.label = pick(labels);
    if (field === "collapsed") fields.collapsed = chance(0.5);
    if (field === "expanded") fields.expanded = chance(0.5);
    if (field === "foldRibbon") fields.foldRibbon = pick(["hover", "always", null]);
    if (field === "html") fields.html = pick(["", "<p>y</p>"]);
    return { type: "set", id: pick(ids), ...fields };
}

const parse: any[] = [];
const canonical = [
    '<nav fold-ribbon="always">',
    "  <happy-search/>",
    "  <happy-create/>",
    '  <happy-space id="happy" expanded="true">',
    '    <happy-space id="session1" fold-ribbon="hover"/>',
    "  </happy-space>",
    '  <happy-separator id="divider"/>',
    '  <happy-section id="releases" label="Releases &amp; &quot;ships&quot;" collapsed="true"/>',
    '  <happy-space id="android"/>',
    '  <happy-widget id="status"><div class="card">Build <b>green</b><br>\n  "quoted" & raw</div></happy-widget>',
    '  <happy-widget id="empty"/>',
    '  <happy-section id="tasks" label="Tasks"/>',
    '  <happy-space id="pricing"/>',
    "</nav>",
    "",
].join("\n");
const handwritten = [
    canonical,
    `<nav>\n<happy-create></happy-create><happy-search />\n<happy-section label='Bots' collapsed="false" id="bots"/>\n<happy-space expanded="false" id="bot1"></happy-space>\n<happy-widget id="w"></happy-widget >\n</nav>`,
    `<nav><happy-search/><happy-create/><happy-section id="x" label="&#x41;&#66;&#0;&#xD800;&#99999999999;&AMP;&bogus;"/></nav>`,
    `<nav><happy-search/><happy-create/>text</nav>`,
    `<nav><happy-search/></nav>`,
    `<nav><happy-search/><happy-create/><happy-search/></nav>`,
    `<nav><happy-search/><happy-create/><happy-space id="a"><happy-section id="b" label="x"/></happy-space></nav>`,
    `<nav><happy-search/><happy-create/><happy-space id="a"/><happy-space id="a"/></nav>`,
    `<nav><happy-search/><happy-create/><happy-space id="nav"/></nav>`,
    `<nav><happy-search/><happy-create/><happy-space id=a/></nav>`,
    `<nav><happy-search/><happy-create/><happy-space id="a"expanded="true"/></nav>`,
    `<nav><happy-search/><happy-create/><happy-space id="a" id="b"/></nav>`,
    `<nav><happy-search/><happy-create/><happy-space id="a" extra="1"/></nav>`,
    `<nav><happy-search/><happy-create/><happy-section id="s" label="   "/></nav>`,
    `<nav><happy-search/><happy-create/><happy-separator id="s" label="x"/></nav>`,
    `<nav><happy-search/><happy-create/><happy-space id="a b"/></nav>`,
    `<nav><happy-search/><happy-create/><happy-widget id="w"><b></HAPPY-WIDGET></happy-widget></nav>`,
    `<nav><happy-search/><happy-create/><happy-widget id="w">unterminated</nav>`,
    `<nav><happy-search/><happy-create/></happy-space></nav>`,
    `<nav><happy-search/><happy-create/><happy-spaceX id="a"/></nav>`,
    `<nav><happy-search/><happy-create/><Happy-space id="a"/></nav>`,
    `<nav/>`,
    `<nav><happy-search/><happy-create/></nav><nav></nav>`,
    `<happy-search/>`,
    `<nav><happy-search/><happy-create/>`,
    `\n  <nav>\n<happy-search\n/><happy-create\t/></nav>\n\n`,
    `<nav fold-ribbon="never"><happy-search/><happy-create/></nav>`,
    `<nav><happy-search/><happy-create/><happy-space id="a" expanded="yes"/></nav>`,
    `<nav><happy-search/><happy-create/><happy-space id="✨"/></nav>`,
    `<nav><happy-search/><happy-create/><happy-space id="${"x".repeat(129)}"/></nav>`,
    `<nav><happy-search/><happy-create/><happy-space id="a" expanded = 'true' /></nav>`,
    `<nav>\u00a0<happy-search/>\u2028<happy-create/>\ufeff</nav>`,
    `<nav><happy-search/><happy-create/><happy-space id="a">${"<happy-space id=\"q\">".repeat(1)}</happy-space></nav>`,
];
const deep = (n: number) => `<nav><happy-search/><happy-create/>${Array.from({ length: n }, (_, i) => `<happy-space id="d${i}">`).join("")}${Array.from({ length: n }, () => "</happy-space>").join("")}</nav>`;
handwritten.push(deep(14), deep(15), deep(16));
for (let i = 0; i < 80; i++) {
    let html = formatSpaceSidebar(randomDocument());
    // Mutate some of them into broken text.
    if (chance(0.6)) {
        const at = Math.floor(random() * html.length);
        const roll = random();
        if (roll < 0.3) html = html.slice(0, at) + html.slice(at + 1);
        else if (roll < 0.6) html = html.slice(0, at) + pick(["<", ">", '"', "'", "/", " ", "x", "&", "</nav>"]) + html.slice(at);
        else html = html.slice(0, at) + html.slice(at + 1 + Math.floor(random() * 20));
    }
    handwritten.push(html);
}
for (const html of handwritten) {
    try {
        parse.push({ html, formatted: formatSpaceSidebar(parseSpaceSidebar(html)), withoutWidgets: formatSpaceSidebar(parseSpaceSidebar(html), { widgets: false }) });
    } catch (e) {
        parse.push({ html, error: error(e) });
    }
}

const apply: any[] = [];
for (let i = 0; i < 700; i++) {
    const document = randomDocument();
    const html = formatSpaceSidebar(document);
    const operations = Array.from({ length: 1 + Math.floor(random() * 4) }, () => randomOperation(document));
    // A base the operations were made against, with some anchors taken out since.
    let base: any;
    let current = document;
    if (chance(0.35)) {
        base = document;
        const removable = allIds(document).filter((id) => !["happy-search", "happy-create"].includes(id));
        current = structuredClone(document);
        for (let k = 0; k < 3; k++) {
            const id = pick(removable);
            try {
                current = applySpaceSidebarOperations(current, [{ type: "remove", id }]).document;
            } catch {}
        }
    }
    const entry: any = { html: formatSpaceSidebar(current), operations, ...(base ? { base: html } : {}) };
    try {
        const result = applySpaceSidebarOperations(current, operations, base ? { base } : {});
        entry.result = formatSpaceSidebar(result.document);
        entry.applied = result.operations;
    } catch (e) {
        entry.error = error(e);
    }
    apply.push(entry);
}

// Diffs: a proposal made by random edits, including whole-block section moves.
const diff: any[] = [];
for (let i = 0; i < 300; i++) {
    const current = randomDocument();
    let proposed = structuredClone(current);
    for (let k = 0; k < 1 + Math.floor(random() * 5); k++) {
        try {
            proposed = applySpaceSidebarOperations(proposed, [randomOperation(proposed)]).document;
        } catch {}
    }
    // Some proposals break a section's block apart, or shuffle the top level.
    if (chance(0.2)) proposed.items.reverse();
    const widgets = chance(0.85);
    if (!widgets) proposed.items = proposed.items.filter((item: any) => item.type !== "widget");
    const entry: any = { current: formatSpaceSidebar(current), proposed: formatSpaceSidebar(proposed), widgets };
    try {
        entry.operations = diffSpaceSidebar(current, proposed, { widgets });
    } catch (e) {
        entry.error = e instanceof Error ? e.message : String(e);
    }
    diff.push(entry);
}

// Desktop's edits, named by node ID; the desktop names nodes by kind and ID.
const keyOf = (document: any, id: string | null): string | null => {
    if (id === null) return null;
    if (id === "happy-search") return "search";
    if (id === "happy-create") return "create";
    const top = document.items.find((item: any) => item.id === id);
    if (top) return `${top.type}:${id}`;
    return `session:${id}`;
};
const edits: any[] = [];
for (let i = 0; i < 400; i++) {
    const document = randomDocument();
    const html = formatSpaceSidebar(document);
    const ids = allIds(document);
    const kind = pick(["move", "move", "move", "fold", "place", "place", "insert", "reveal"]);
    const entry: any = { html, kind };
    let edited: string | undefined;
    if (kind === "move") {
        const id = pick(ids);
        const after = chance(0.15) ? null : pick(ids);
        Object.assign(entry, { id, after });
        edited = desktop.sidebarDocumentEdit(html, (view: any) => desktop.sidebarDocumentMove(view, keyOf(document, id), keyOf(document, after)));
    } else if (kind === "fold") {
        const id = pick(ids);
        entry.id = id;
        edited = desktop.sidebarDocumentEdit(html, (view: any) => desktop.sidebarDocumentFold(view, keyOf(document, id)));
    } else if (kind === "place") {
        const id = pick(ids);
        const parent = chance(0.4) ? null : pick(ids);
        const after = chance(0.3) ? null : pick(ids);
        Object.assign(entry, { id, parent, after });
        edited = desktop.sidebarDocumentEdit(html, (view: any) => desktop.sidebarDocumentPlace(view, keyOf(document, id), keyOf(document, parent), keyOf(document, after)));
    } else if (kind === "insert") {
        const spaces = document.items.filter((item: any) => item.type === "space").map((item: any) => item.id);
        const sections = document.items.filter((item: any) => item.type === "section" || item.type === "separator").map((item: any) => item.id);
        const spaceId = chance(0.9) ? fresh("new") : pick(spaces.length ? spaces : ["x"]);
        const sectionId = chance(0.3) && sections.length ? pick(sections) : null;
        const happySpaceId = chance(0.8) && spaces.length ? pick(spaces) : null;
        Object.assign(entry, { spaceId, sectionId, happySpaceId });
        edited = desktop.sidebarDocumentEdit(html, (view: any) => desktop.sidebarDocumentInsert(view, spaceId, sectionId, happySpaceId));
    } else {
        const spaces = ids.filter((id) => !["happy-search", "happy-create"].includes(id));
        const id = pick(spaces);
        const tree = (depth: number): any[] =>
            Array.from({ length: Math.floor(random() * 3) }, () => ({ id: chance(0.4) ? pick(ids) : fresh("t"), children: depth < 2 ? tree(depth + 1) : [] }));
        const sessions = tree(0);
        Object.assign(entry, { id, sessions });
        edited = desktop.sidebarDocumentEdit(html, (view: any) => desktop.sidebarDocumentSessionsReveal(view, keyOf(document, id), sessions));
    }
    entry.result = edited ?? null;
    edits.push(entry);
}

// Hide subtasks, after the edits so their vectors stay as they were: the
// sessions under a row go, and a space nested under one takes its place.
const hides: any[] = [];
for (let i = 0; i < 120; i++) {
    const document = randomDocument();
    const html = formatSpaceSidebar(document);
    const ids = allIds(document).filter((id) => !["happy-search", "happy-create"].includes(id));
    const id = pick(ids);
    const attached = document.items.filter((item: any) => item.type === "space").map((item: any) => item.id).filter(() => chance(0.7));
    const isAttached = (candidate: string) => attached.includes(candidate);
    const edited = desktop.sidebarDocumentEdit(html, (view: any) => desktop.sidebarDocumentSessionsHide(view, keyOf(document, id), isAttached));
    hides.push({ html, id, attached, result: edited ?? null });
}

const out = resolve(import.meta.dir, "../Tests/HappyCoreTests/Fixtures/space-sidebar-vectors.json");
writeFileSync(out, JSON.stringify({ parse, apply, diff, edits, hides }) + "\n");
console.log(`parse ${parse.length}, apply ${apply.length}, diff ${diff.length}, edits ${edits.length}, hides ${hides.length}`);
