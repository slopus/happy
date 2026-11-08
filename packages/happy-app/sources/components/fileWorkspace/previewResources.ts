/** Resolve URL-style dependencies under the authorized workspace, never the host filesystem root. */
export function resolvePreviewPath(reference: string, owner: string, root: string): { path: string; fragment: string } {
    const base = root.replace(/\/$/, '');
    if (!owner.startsWith(base + '/')) throw new Error('Preview outside workspace');
    const decoded = decodeURIComponent(reference);
    if (/^[a-z][\w+.-]*:/i.test(decoded) || decoded.startsWith('//') || /[\\\0]/.test(decoded)) throw new Error('External preview resource');
    const hash = decoded.indexOf('#');
    const fragment = hash < 0 ? '' : decoded.slice(hash);
    const value = (hash < 0 ? decoded : decoded.slice(0, hash)).split('?')[0];
    if (!value) return { path: owner, fragment };
    const parts = value.startsWith('/') ? [] : owner.slice(base.length + 1).split('/').slice(0, -1);
    for (const piece of value.split('/')) {
        if (!piece || piece === '.') continue;
        if (piece === '..') { if (!parts.length) throw new Error('Preview resource outside workspace'); parts.pop(); }
        else parts.push(piece);
    }
    return { path: base + '/' + parts.join('/'), fragment };
}
