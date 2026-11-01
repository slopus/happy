#!/usr/bin/env node
// Generates Tests/HappyCoreTests/Fixtures/documents.json: document Surfaces
// as the daemon and desktop store them, so the Swift Yjs port and block
// model are checked against the real thing rather than against themselves.
//
// Every document is made by the daemon's own conversion code
// (happy-agent-modules/sources/surfaces/documents: markdownToBlocks,
// readDocument, blocksToMarkdown) over yjs 13.6 and BlockNote 0.51.4, the
// versions desktop pins. Each fixture carries the Yjs update, the Markdown
// the daemon projects from it, BlockNote's own block JSON and the XML tree.
// Merge fixtures add two concurrent edits from fixed client IDs and the
// document yjs ends with once both are applied.
//
// Usage:
//   HAPPY_DOCUMENT_DEPS=<dir with node_modules holding yjs, @blocknote/core,
//     y-prosemirror, prosemirror-model, markdown-it>
//   HAPPY_AGENT_DOCUMENTS=<happy-agent>/packages/happy-agent-modules/sources/surfaces/documents
//   node packages/happy-ios/scripts/generate-document-fixtures.mjs
//
// The daemon sources are TypeScript; they are copied next to the deps with
// their `.js` imports pointed at `.ts`, and Node strips the types.
//
// `verify` mode checks documents the Swift tests wrote (DocumentInteropTests
// with HAPPY_DOCUMENT_INTEROP set) the same way:
//   node generate-document-fixtures.mjs verify <dir>

import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const deps = process.env.HAPPY_DOCUMENT_DEPS ?? path.resolve(here, '../../../.context/js');
const sources = process.env.HAPPY_AGENT_DOCUMENTS ?? '/Users/steve/Developer/happy-agent/packages/happy-agent-modules/sources/surfaces/documents';
const daemonDir = path.join(deps, 'daemon');
mkdirSync(daemonDir, { recursive: true });
for (const file of ['documentEditor.ts', 'readDocument.ts', 'markdownToBlocks.ts', 'blocksToMarkdown.ts']) {
    const text = readFileSync(path.join(sources, file), 'utf8').replace(/from "(\.\/[^"]+)\.js"/g, 'from "$1.ts"');
    writeFileSync(path.join(daemonDir, file), text);
}
const load = (name) => import(pathToFileURL(path.join(daemonDir, name)).href);
const Y = await import(pathToFileURL(path.join(deps, 'node_modules/yjs/dist/yjs.mjs')).href);
const { readDocument, markdownToUpdate } = await load('readDocument.ts');
const { documentEditor, DOCUMENT_FRAGMENT } = await load('documentEditor.ts');
const { blocksToYXmlFragment, yXmlFragmentToBlocks } = await import(pathToFileURL(path.join(deps, 'node_modules/@blocknote/core/dist/yjs.js')).href);

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const fromB64 = (text) => new Uint8Array(Buffer.from(text, 'base64'));

function docOf(update) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, update);
    return doc;
}

function fromBlocks(blocks) {
    const doc = new Y.Doc();
    doc.clientID = 4242;
    blocksToYXmlFragment(documentEditor(), blocks, doc.getXmlFragment(DOCUMENT_FRAGMENT));
    return Y.encodeStateAsUpdate(doc);
}

function describe(update) {
    const doc = docOf(update);
    const blocks = yXmlFragmentToBlocks(documentEditor(), doc.getXmlFragment(DOCUMENT_FRAGMENT));
    const reading = readDocument(update);
    return {
        markdown: reading.text,
        omitted: reading.omitted,
        outsideModel: reading.outsideModel,
        blocks,
        xml: doc.getXmlFragment(DOCUMENT_FRAGMENT).toJSON(),
    };
}

/** Sorted keys, tables as their cells' text: the shape both sides compare in. */
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value === null || typeof value !== 'object') return value;
    const object = { ...value };
    if (object.type === 'table') {
        object.props = {};
        if (object.content?.rows) object.content = object.content.rows.map((row) => row.cells.map((cell) => (cell.content ?? []).map((t) => t.text ?? '').join('')));
    }
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonical(object[key])]));
}

if (process.argv[2] === 'verify') {
    const dir = process.argv[3];
    let failures = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        const cases = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
        for (const c of cases) {
            const got = describe(fromB64(c.state));
            const problems = [];
            if (c.markdown !== undefined && got.markdown !== c.markdown) problems.push(`markdown\n--- swift\n${c.markdown}\n--- daemon\n${got.markdown}`);
            if (got.outsideModel) problems.push('content outside the BlockNote model');
            const ours = JSON.stringify(canonical(c.blocks));
            const theirs = JSON.stringify(canonical(got.blocks));
            if (c.blocks !== undefined && ours !== theirs) problems.push(`blocks\n--- swift\n${ours}\n--- blocknote\n${theirs}`);
            if (problems.length > 0) { failures += 1; console.log(`FAIL ${file} ${c.name}:\n${problems.join('\n')}`); } else console.log(`ok   ${file} ${c.name}`);
        }
    }
    process.exit(failures === 0 ? 0 : 1);
}

const text = (value, styles = {}) => ({ type: 'text', text: value, styles });
const desktopReadme = `# Happy file viewer

Opening a file shows the file. A Markdown document reads as a document — on a
reading measure, in the document type ramp — rather than as a wall of source.

## What renders

- **Headings** open a section and take air above them
- Lists, nested lists, and task lists
- Tables, block quotes, and fenced code
- Links: the web opens outside, [a file](master-plans/03-file-viewer.md) opens here

### Task list

- [x] Read the file
- [ ] Write it back

> A preview that crops has answered a different question than the one asked.

| Kind     | Opens as        | Scrolls |
| -------- | --------------- | ------- |
| Markdown | Rendered prose  | Yes     |
| Image    | Contained stage | No      |
| Source   | Monospace text  | Yes     |

\`\`\`ts
export function filePreviewKind(path: string): FilePreviewKind {
    return EXTENSION_KIND[extensionOf(path)] ?? "binary";
}
\`\`\`

\`\`\`mermaid
flowchart LR
    Markdown --> Render[Beautiful Mermaid]
    Render --> SVG[Validated themed SVG]
\`\`\`

Inline \`code\` keeps the mono face, and a rule closes the document.

---

Last read from the workspace, not the browser.
`;
const desktopShort = `## Release notes

Two paragraphs and a list is the ordinary case, and it should look composed at
any width the panel is dragged to.

1. Files open inside Happy
2. Markdown renders
3. Chat links reuse the same viewer
`;
const daemonRoundTrip = [
    '# Plan', '', 'Intro with a hard  ', 'break and *emphasis*.', '', '## Steps', '',
    '1. First', '2. Second', '   - nested bullet', '     - deeper', '3. Third', '',
    '- [ ] open task', '- [x] done task', '- plain bullet', '', '> A quote', '',
    '```ts', 'const a_b = `x`;', '```', '', '---', '',
    '| Name | Value |', '| --- | --- |', '| a_b | 1 \\| 2 |', '',
    '![diagram](https://example.com/d.png)', '', '###### Deep heading',
].join('\n');
const escapes = [
    'a_snake_name and snake_case_words', '5 * 3 = 15 and C:\\path\\to\\file', 'a ~ b, 3 < 4, x | y, R&D',
    '2*3*4', '_leading and trailing_', '[not a link](x) `tick` ~~struck~~ <b> &amp;',
    '# Title', '- item', '+ item', '> quote', '1. one', '2) two', '---', '===',
    '_x_ *y* __z__ **w**', '~~ tilde ~ run ~~', 'back\\slash \\* \\_ \\', '[brackets] ](odd)[ ![image](x)',
    '`ticks` and ``double``', '<http://example.com> <tag> a<b', '&copy; &#169; &#xA9; & alone',
    '   leading and trailing   ', 'tab\tinside', '#', 'Heading ending with #', 'emoji 😀 and ünïcödé',
];

const documents = [];
const add = (name, update, source) => documents.push({ name, ...(source === undefined ? {} : { source }), update: b64(update), ...describe(update) });

add('desktop-seed', fromB64(readFileSync('/Users/steve/Developer/happy-desktop/packages/happy-desktop-ui/src/documentEditorSeed.ts', 'utf8').match(/"(AS[^"]+)"/)[1]));
add('desktop-readme', markdownToUpdate(desktopReadme), desktopReadme);
add('desktop-short', markdownToUpdate(desktopShort), desktopShort);
add('daemon-round-trip', markdownToUpdate(daemonRoundTrip), daemonRoundTrip);
escapes.forEach((sample, i) => add(`escape-${i}`, fromBlocks([{ type: 'paragraph', content: [text(sample)] }])));
add('formatting', fromBlocks([
    { type: 'paragraph', content: [
        text('bold', { bold: true }), text(' and '), text('both', { bold: true, italic: true }), text(' '),
        text('code', { code: true }), text(' '), text('struck', { strike: true }), text(' '),
        text('under', { underline: true }), text(' '), text('red', { textColor: 'red' }), text(' '),
        text('marked', { backgroundColor: 'yellow' }),
        { type: 'link', href: 'https://example.com/a b(c)', content: [text('link')] },
    ] },
    { type: 'paragraph', props: { textAlignment: 'center' }, content: [text('Centered')] },
]));
add('blocks', fromBlocks([
    { type: 'heading', props: { level: 1 }, content: [text('Title')] },
    { type: 'heading', props: { level: 2 }, content: [text('Second')] },
    { type: 'heading', props: { level: 3 }, content: [text('Third')] },
    { type: 'paragraph', content: [text('Line one\nline two')] },
    { type: 'paragraph', content: [] },
    { type: 'bulletListItem', content: [text('Outer')], children: [
        { type: 'bulletListItem', content: [text('Inner')], children: [{ type: 'checkListItem', props: { checked: true }, content: [text('Deep done')] }] },
    ] },
    { type: 'numberedListItem', content: [text('One')] },
    { type: 'numberedListItem', content: [text('Two')] },
    { type: 'checkListItem', props: { checked: false }, content: [text('Open')] },
    { type: 'quote', content: [text('Quoted '), text('bold', { bold: true })] },
    { type: 'codeBlock', props: { language: 'swift' }, content: 'let x = 1\nprint(x)' },
    { type: 'codeBlock', content: 'plain' },
    { type: 'divider' },
    { type: 'image', props: { url: 'https://example.com/cat.png', name: 'cat', caption: 'A cat' } },
    { type: 'toggleListItem', content: [text('Toggle')] },
    { type: 'paragraph', content: [{ type: 'link', href: 'https://happy.engineering', content: [text('Happy '), text('bold', { bold: true })] }] },
]));
add('empty', fromBlocks([{ type: 'paragraph', content: [] }]));
{
    // A block outside the model: the editor must keep it and never write over it.
    const doc = docOf(fromBlocks([{ type: 'paragraph', content: [text('Kept')] }]));
    const group = doc.getXmlFragment(DOCUMENT_FRAGMENT).get(0);
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', 'future');
    container.insert(0, [new Y.XmlElement('futureBlock')]);
    group.insert(group.length, [container]);
    add('outside-model', Y.encodeStateAsUpdate(doc));
}

// Concurrent edits: base, then edits from client 1 (a) and client 2 (b),
// each made on its own replica of base without seeing the other.
const merges = [];
function merge(name, baseBlocks, editA, editB) {
    const base = fromBlocks(baseBlocks);
    const replica = (client) => { const doc = docOf(base); doc.clientID = client; return doc; };
    const da = replica(1);
    const db = replica(2);
    const sva = Y.encodeStateVector(da);
    const svb = Y.encodeStateVector(db);
    da.transact(() => editA(da, da.getXmlFragment(DOCUMENT_FRAGMENT)));
    db.transact(() => editB(db, db.getXmlFragment(DOCUMENT_FRAGMENT)));
    const a = Y.encodeStateAsUpdate(da, sva);
    const b = Y.encodeStateAsUpdate(db, svb);
    const merged = docOf(base);
    Y.applyUpdate(merged, b);
    Y.applyUpdate(merged, a);
    merges.push({ name, base: b64(base), a: b64(a), b: b64(b), merged: describe(Y.encodeStateAsUpdate(merged)) });
}
const containers = (fragment) => fragment.get(0).toArray();
const content = (fragment, i) => containers(fragment)[i].get(0);
const textOf = (fragment, i) => content(fragment, i).get(0);
const para = (s) => ({ type: 'paragraph', content: [text(s)] });
merge('typing-apart', [para('Hello world')], (d, f) => textOf(f, 0).insert(5, ' there'), (d, f) => textOf(f, 0).insert(11, '!'));
merge('typing-same-spot', [para('ab')], (d, f) => textOf(f, 0).insert(1, 'X'), (d, f) => textOf(f, 0).insert(1, 'Y'));
merge('delete-over-insert', [para('one two three')], (d, f) => textOf(f, 0).delete(4, 4), (d, f) => textOf(f, 0).insert(6, 'ooo'));
merge('bold-and-type', [para('make this bold')], (d, f) => textOf(f, 0).format(5, 4, { bold: {} }), (d, f) => textOf(f, 0).insert(7, 'IS'));
merge('split-and-edit', [para('first half second half')], (d, f) => {
    const t = textOf(f, 0);
    t.delete(10, 12);
    const group = f.get(0);
    const c = new Y.XmlElement('blockContainer');
    c.setAttribute('id', 'split-block');
    const p = new Y.XmlElement('paragraph');
    const x = new Y.XmlText();
    x.insert(0, 'second half');
    p.insert(0, [x]);
    c.insert(0, [p]);
    group.insert(1, [c]);
}, (d, f) => textOf(f, 0).insert(22, ' edited'));
merge('check-and-type', [{ type: 'checkListItem', props: { checked: false }, content: [text('Task')] }], (d, f) => content(f, 0).setAttribute('checked', true), (d, f) => textOf(f, 0).insert(4, ' one'));
merge('delete-block-edit-block', [para('keep'), para('gone')], (d, f) => f.get(0).delete(1, 1), (d, f) => textOf(f, 1).insert(4, ' typed'));
merge('heading-levels', [{ type: 'heading', props: { level: 1 }, content: [text('Title')] }], (d, f) => content(f, 0).setAttribute('level', 2), (d, f) => content(f, 0).setAttribute('level', 3));

// Cursors as desktop's y-prosemirror sends them: every caret position in
// every text block turned into a relative position, then where each lands
// after another replica's edit.
const { initProseMirrorDoc, absolutePositionToRelativePosition, relativePositionToAbsolutePosition } = await import(pathToFileURL(path.join(deps, 'node_modules/y-prosemirror/src/lib.js')).href);
const { encodeAwarenessUpdate, Awareness } = await import(pathToFileURL(path.join(deps, 'node_modules/y-protocols/awareness.js')).href);
const pmSchema = documentEditor().pmSchema;
function caret(pm, pos) {
    const at = pm.resolve(pos);
    if (!at.parent.isTextblock) return null;
    return { id: at.node(at.depth - 1).attrs.id, offset: at.parentOffset };
}
const cursors = [];
function cursorCase(name, blocks, edit) {
    const base = fromBlocks(blocks);
    const doc = docOf(base);
    const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT);
    const { doc: pm, mapping } = initProseMirrorDoc(fragment, pmSchema);
    const positions = [];
    pm.descendants((node, pos) => {
        if (!node.isTextblock) return true;
        for (let offset = 0; offset <= node.content.size; offset += 1) {
            const at = caret(pm, pos + 1 + offset);
            positions.push({ ...at, relative: JSON.parse(JSON.stringify(absolutePositionToRelativePosition(pos + 1 + offset, fragment, mapping))) });
        }
        return false;
    });
    const other = docOf(base);
    other.clientID = 7;
    const sv = Y.encodeStateVector(other);
    other.transact(() => edit(other.getXmlFragment(DOCUMENT_FRAGMENT)));
    const update = Y.encodeStateAsUpdate(other, sv);
    Y.applyUpdate(doc, update);
    const after = initProseMirrorDoc(fragment, pmSchema);
    for (const p of positions) {
        const pos = relativePositionToAbsolutePosition(doc, fragment, Y.createRelativePositionFromJSON(p.relative), after.mapping);
        p.after = pos === null ? null : caret(after.doc, pos);
    }
    cursors.push({ name, base: b64(base), edit: b64(update), positions });
}
const lines = (...texts) => texts.map((s) => s === '' ? { type: 'paragraph' } : para(s));
cursorCase('typing-before', lines('Hello', 'world'), (f) => textOf(f, 0).insert(0, 'Oh, '));
cursorCase('empty-blocks', lines('', 'two', ''), (f) => textOf(f, 1).insert(3, '!'));
cursorCase('formatted', [{ type: 'paragraph', content: [text('plain '), text('bold', { bold: true }), text(' end')] }], (f) => textOf(f, 0).delete(2, 6));
cursorCase('hard-break', [{ type: 'paragraph', content: [text('one\ntwo')] }, para('three')], (f) => textOf(f, 1).insert(0, '>'));
cursorCase('nested', [{ type: 'bulletListItem', content: [text('parent')], children: [{ type: 'bulletListItem', content: [text('child')] }] }], (f) => content(f, 0).get(0).insert(6, 's'));
cursorCase('block-deleted', lines('keep', 'gone', 'after'), (f) => f.get(0).delete(1, 1));

// Awareness as desktop's editor announces it: BlockNote's user and
// y-prosemirror's cursor.
const awarenessDoc = docOf(fromBlocks(lines('Hello')));
awarenessDoc.clientID = 31337;
const awareness = new Awareness(awarenessDoc);
awareness.setLocalState({ user: { name: 'Steve', color: '#ff6b6b' } });
const anchor = Y.createRelativePositionFromTypeIndex(textOf(awarenessDoc.getXmlFragment(DOCUMENT_FRAGMENT), 0), 2);
awareness.setLocalStateField('cursor', { anchor, head: anchor });
const presence = { clientID: awareness.clientID, update: b64(encodeAwarenessUpdate(awareness, [awareness.clientID])), state: JSON.parse(JSON.stringify(awareness.getLocalState())) };
awareness.destroy();

const out = path.resolve(here, '../Tests/HappyCoreTests/Fixtures/documents.json');
writeFileSync(out, JSON.stringify({ blocknote: '0.51.4', yjs: '13.6.31', documents, merges, cursors, presence }, null, 1) + '\n');
console.log(`wrote ${documents.length} documents, ${merges.length} merges and ${cursors.length} cursor cases to ${path.relative(process.cwd(), out)}`);
