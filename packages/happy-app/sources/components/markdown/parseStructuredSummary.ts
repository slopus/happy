export type StructuredSummary = { analysis: string; summary: string };

/** Syntax-only display compatibility; original text and provider semantics stay intact. */
export function parseStructuredSummary(text: string): StructuredSummary | null {
    if (!/^(?:[ \t]*\r?\n)*<analysis>[ \t]*\r?\n/.test(text)) return null;
    const lines = text.replaceAll('\r\n', '\n').split('\n');
    let cursor = 0;
    const skipBlank = () => { while (cursor < lines.length && lines[cursor].trim() === '') cursor++; };
    const readSection = (name: 'analysis' | 'summary'): string | null => {
        if (lines[cursor]?.trimEnd() !== `<${name}>`) return null;
        const start = ++cursor;
        let fence: { char: string; length: number } | null = null;
        for (; cursor < lines.length; cursor++) {
            const line = lines[cursor];
            if (fence) {
                const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
                if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) fence = null;
                continue;
            }
            const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
            if (opening && (opening[1][0] !== '`' || !opening[2].includes('`'))) {
                fence = { char: opening[1][0], length: opening[1].length };
                continue;
            }
            if (/^ {0,3}<\/?(?:analysis|summary)>[ \t]*$/.test(line)) {
                if (line.trimEnd() !== `</${name}>`) return null;
                const body = lines.slice(start, cursor++);
                while (body.length && body[0].trim() === '') body.shift();
                while (body.length && body[body.length - 1].trim() === '') body.pop();
                return body.length ? body.join('\n') : null;
            }
        }
        return null;
    };
    skipBlank();
    const analysis = readSection('analysis');
    if (analysis === null) return null;
    skipBlank();
    const summary = readSection('summary');
    if (summary === null) return null;
    skipBlank();
    return cursor === lines.length ? { analysis, summary } : null;
}
