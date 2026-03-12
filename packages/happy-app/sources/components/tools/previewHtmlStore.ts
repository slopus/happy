/**
 * Simple module-level store for passing HTML content to the preview route.
 * HTML can be very large, so we use a module variable instead of URL params.
 */
let _pendingHtml: string | null = null;
let _pendingTitle: string | null = null;

export function setPreviewHtml(html: string, title: string | null) {
    _pendingHtml = html;
    _pendingTitle = title;
}

export function consumePreviewHtml(): { html: string | null; title: string | null } {
    const result = { html: _pendingHtml, title: _pendingTitle };
    _pendingHtml = null;
    _pendingTitle = null;
    return result;
}
