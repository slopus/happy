/** Resolve URL-style dependencies under the authorized workspace, never the host filesystem root. */
export function resolvePreviewPath(reference: string, owner: string, root: string): { path: string; fragment: string } {
    const base = root.replace(/\/$/, '');
    if (!owner.startsWith(base + '/')) throw new Error('Preview outside workspace');
    // Split URL delimiters before decoding: %23 and %3F belong to a filename.
    const hash = reference.indexOf('#');
    const fragment = hash < 0 ? '' : reference.slice(hash);
    const rawPath = (hash < 0 ? reference : reference.slice(0, hash)).split('?')[0];
    const value = decodeURIComponent(rawPath);
    if (/^[a-z][\w+.-]*:/i.test(value) || value.startsWith('//') || /[\\\0]/.test(value)) throw new Error('External preview resource');
    if (!value) return { path: owner, fragment };
    const parts = value.startsWith('/') ? [] : owner.slice(base.length + 1).split('/').slice(0, -1);
    for (const piece of value.split('/')) {
        if (!piece || piece === '.') continue;
        if (piece === '..') { if (!parts.length) throw new Error('Preview resource outside workspace'); parts.pop(); }
        else parts.push(piece);
    }
    return { path: base + '/' + parts.join('/'), fragment };
}
