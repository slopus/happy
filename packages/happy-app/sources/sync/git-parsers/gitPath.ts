export function decodeGitPath(path: string): string {
    if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) {
        return path;
    }

    const value = path.slice(1, -1);
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const bytes: number[] = [];
    let plain = '';

    const flushPlain = () => {
        if (!plain) return;
        bytes.push(...encoder.encode(plain));
        plain = '';
    };

    for (let i = 0; i < value.length;) {
        const ch = value[i];
        if (ch !== '\\') {
            plain += ch;
            i += 1;
            continue;
        }

        const next = value[i + 1];
        if (next === undefined) {
            plain += ch;
            i += 1;
            continue;
        }

        const octal = value.slice(i + 1).match(/^[0-7]{1,3}/)?.[0];
        if (octal) {
            flushPlain();
            bytes.push(parseInt(octal, 8));
            i += 1 + octal.length;
            continue;
        }

        const escaped = decodeSimpleEscape(next);
        if (escaped !== null) {
            plain += escaped;
            i += 2;
            continue;
        }

        plain += next;
        i += 2;
    }

    flushPlain();
    return decoder.decode(new Uint8Array(bytes));
}

function decodeSimpleEscape(value: string): string | null {
    switch (value) {
        case 'a': return '\x07';
        case 'b': return '\b';
        case 'f': return '\f';
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case 'v': return '\v';
        case '"': return '"';
        case '\\': return '\\';
        default: return null;
    }
}
