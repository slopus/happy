/** Self-contained originals may run their own controls, without contacting the
 * network or sharing the app's origin, storage, forms, or native bridge. */
export function goalHtmlDocument(content: string): string {
    const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`;
    // Establish policy before parsing any source bytes, including malformed or
    // commented head tags. Nested document tags are normalized by the browser.
    return `<!doctype html><html><head>${policy}</head><body>${content}</body></html>`;
}

/** The embedding host restricts child-frame navigation as well as subresources.
 * An inner document's own connect-src alone cannot prevent location.href leaks. */
export function goalHtmlHostDocument(content: string, title = ''): string {
    const source = JSON.stringify(goalHtmlDocument(content)).replace(/</g, '\\u003c');
    const label = JSON.stringify(title).replace(/</g, '\\u003c');
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; frame-src blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;overflow:hidden}</style></head><body><iframe sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe><script>const frame=document.querySelector('iframe');frame.title=${label};const url=URL.createObjectURL(new Blob([${source}],{type:'text/html;charset=utf-8'}));frame.src=url;addEventListener('pagehide',()=>URL.revokeObjectURL(url),{once:true});</script></body></html>`;
}
