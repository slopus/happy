import { describe, it, expect } from 'vitest';
import { rewriteHtml, rewriteJsCss, rwPath, rwInput } from '@/modules/preview/rewriteHtml';

const PREFIX = '/v1/preview/m1/3000';

// Phase 9: the auth secret no longer travels via URL — the relay sets a
// path-scoped HttpOnly cookie on the first response, and every subsequent
// subresource request picks it up automatically. The rewriter must stop
// appending ?ptoken= to rewritten URLs. See plan.md Phase 9 step 3.

describe('rewriteHtml — absolute path rewriting', () => {
    it('rewrites src="/..." to prefix', () => {
        const out = rewriteHtml('<img src="/logo.png">', PREFIX);
        expect(out).toContain(`src="${PREFIX}/logo.png"`);
    });

    it('rewrites href="/..." to prefix', () => {
        const out = rewriteHtml('<link href="/main.css">', PREFIX);
        expect(out).toContain(`href="${PREFIX}/main.css"`);
    });

    it('rewrites action="/..." to prefix', () => {
        const out = rewriteHtml('<form action="/submit">', PREFIX);
        expect(out).toContain(`action="${PREFIX}/submit"`);
    });

    it('preserves the original query string on rewritten paths', () => {
        const out = rewriteHtml('<script src="/a.js?v=1"></script>', PREFIX);
        expect(out).toContain(`src="${PREFIX}/a.js?v=1"`);
    });

    it('leaves protocol-relative paths (//cdn/...) untouched', () => {
        const out = rewriteHtml('<script src="//cdn.example.com/lib.js"></script>', PREFIX);
        expect(out).toContain('src="//cdn.example.com/lib.js"');
        expect(out).not.toContain(`${PREFIX}//cdn`);
    });

    it('does not double-rewrite already-prefixed paths', () => {
        const already = `<img src="${PREFIX}/logo.png">`;
        const out = rewriteHtml(already, PREFIX);
        expect(out).toContain(`src="${PREFIX}/logo.png"`);
        expect(out).not.toContain(`${PREFIX}${PREFIX}`);
    });

    it('rewrites ES module imports starting with /', () => {
        const out = rewriteHtml(`<script type="module">import foo from '/src/foo.js'</script>`, PREFIX);
        expect(out).toContain(`'${PREFIX}/src/foo.js'`);
    });

    it('rewrites from "/..." in dynamic imports', () => {
        const out = rewriteHtml(`<script>import('/x.js')</script>`, PREFIX);
        expect(out).toContain(`'${PREFIX}/x.js'`);
    });

    it('rewrites poster="/..." on <video>', () => {
        const out = rewriteHtml('<video poster="/thumb.jpg"></video>', PREFIX);
        expect(out).toContain(`poster="${PREFIX}/thumb.jpg"`);
    });

    it('rewrites data="/..." on <object>', () => {
        const out = rewriteHtml('<object data="/app.swf"></object>', PREFIX);
        expect(out).toContain(`data="${PREFIX}/app.swf"`);
    });

    it('rewrites formaction="/..." on <button>', () => {
        const out = rewriteHtml('<button formaction="/api/x">go</button>', PREFIX);
        expect(out).toContain(`formaction="${PREFIX}/api/x"`);
    });

    it('rewrites background="/..." on <body>', () => {
        const out = rewriteHtml('<body background="/bg.png"></body>', PREFIX);
        expect(out).toContain(`background="${PREFIX}/bg.png"`);
    });

    it('leaves external absolute URLs untouched', () => {
        const out = rewriteHtml('<a href="https://example.com/x">ok</a>', PREFIX);
        expect(out).toContain('href="https://example.com/x"');
    });

    it('does not append ?ptoken= to any rewritten src/href/action attribute', () => {
        // Phase 9: URLs must stay clean — cookie-based auth replaces it.
        const input = '<img src="/a.png"><link href="/b.css"><form action="/c"></form>';
        const out = rewriteHtml(input, PREFIX);
        // Scope the assertion to the attribute values so the interceptor
        // script's internal literals (there are none for ptoken in Phase 9,
        // but keep the check explicit) can't cross-contaminate.
        const attrValues = (out.match(/(?:src|href|action)="[^"]+"/g) ?? []).join('\n');
        expect(attrValues).not.toContain('ptoken=');
    });
});

describe('rewriteHtml — extended attribute coverage', () => {
    // Real-world dev servers emit responsive images with srcset and other
    // resource-bearing attributes (poster / data / formaction / background).
    // Missing rewrites caused absolute paths to leak through and 404 against
    // happy-server's own origin — the user-facing symptom is a broken
    // placeholder where the logo should be.
    it('rewrites srcset entries (single URL)', () => {
        const out = rewriteHtml('<img src="/logo.png" srcset="/logo@2x.png 2x">', PREFIX);
        expect(out).toContain(`src="${PREFIX}/logo.png"`);
        expect(out).toContain(`srcset="${PREFIX}/logo@2x.png 2x"`);
    });

    it('rewrites srcset with multiple URL+descriptor pairs', () => {
        const out = rewriteHtml(
            '<img srcset="/a.png 1x, /b.png 2x, //cdn/c.png 3x" alt="x">',
            PREFIX,
        );
        expect(out).toContain(`srcset="${PREFIX}/a.png 1x, ${PREFIX}/b.png 2x, //cdn/c.png 3x"`);
    });

    it('does not double-prefix already-prefixed srcset URLs', () => {
        const already = `<img srcset="${PREFIX}/a.png 1x, ${PREFIX}/b.png 2x">`;
        const out = rewriteHtml(already, PREFIX);
        expect(out).toContain(`srcset="${PREFIX}/a.png 1x, ${PREFIX}/b.png 2x"`);
        expect(out).not.toContain(`${PREFIX}${PREFIX}`);
    });

    it('rewrites <video poster="/...">', () => {
        const out = rewriteHtml('<video poster="/cover.jpg">', PREFIX);
        expect(out).toContain(`poster="${PREFIX}/cover.jpg"`);
    });

    it('rewrites <object data="/...">', () => {
        const out = rewriteHtml('<object data="/doc.pdf"></object>', PREFIX);
        expect(out).toContain(`data="${PREFIX}/doc.pdf"`);
    });

    it('rewrites <button formaction="/...">', () => {
        const out = rewriteHtml('<button formaction="/submit">go</button>', PREFIX);
        expect(out).toContain(`formaction="${PREFIX}/submit"`);
    });

    it('rewrites <body background="/...">', () => {
        const out = rewriteHtml('<body background="/bg.png">', PREFIX);
        expect(out).toContain(`background="${PREFIX}/bg.png"`);
    });

    it('rewrites url(/...) inside HTML (inline <style> or style attr)', () => {
        const out = rewriteHtml(
            `<div style="background: url(/bg.png)"></div><style>.h{background-image:url('/hero.svg')}</style>`,
            PREFIX,
        );
        expect(out).toContain(`url(${PREFIX}/bg.png)`);
        expect(out).toContain(`url('${PREFIX}/hero.svg')`);
    });
});

describe('rewriteHtml — interceptor injection', () => {
    it('injects <base href> before the interceptor script after <head>', () => {
        const out = rewriteHtml('<html><head></head><body></body></html>', PREFIX);
        expect(out).toMatch(new RegExp(`<head><base href="${PREFIX}/"><script>`));
    });

    it('injects after <html> when <head> is absent', () => {
        const out = rewriteHtml('<html><body></body></html>', PREFIX);
        expect(out).toMatch(new RegExp(`<html><base href="${PREFIX}/"><script>`));
    });

    it('prepends <base> + interceptor when neither <head> nor <html> is present', () => {
        const out = rewriteHtml('<div>naked fragment</div>', PREFIX);
        expect(out.startsWith(`<base href="${PREFIX}/"><script>`)).toBe(true);
        expect(out).toContain('<div>naked fragment</div>');
    });

    // <base href> pins the document base URL so that relative-path resources
    // (<script src="app.js">, <link href="style.css">) keep resolving through
    // the relay even after the interceptor's history.replaceState mutates
    // location.pathname. Without this, app.js requests fall back to the
    // platform origin and the browser hits a SPA-fallback HTML page that
    // fails JS parsing with "Unexpected token '<'".
    // See specs/preview-api-proxy/ Phase 5 (R9).
    it('injects <base href> with the configured prefix and trailing slash', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain(`<base href="${PREFIX}/">`);
    });

    it('places <base href> ahead of the interceptor script in document order', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        const baseIdx = out.indexOf('<base href=');
        const scriptIdx = out.indexOf('<script>');
        expect(baseIdx).toBeGreaterThanOrEqual(0);
        expect(scriptIdx).toBeGreaterThanOrEqual(0);
        expect(baseIdx).toBeLessThan(scriptIdx);
    });

    it('interceptor embeds the configured prefix', () => {
        const out = rewriteHtml('<html><head></head><body></body></html>', PREFIX);
        expect(out).toContain(`var P='${PREFIX}'`);
    });

    it('interceptor no longer embeds a ptoken constant (cookie replaces it)', () => {
        const out = rewriteHtml('<html><head></head><body></body></html>', PREFIX);
        expect(out).not.toContain(`var T=`);
        expect(out).not.toContain('ptoken=');
    });

    it('interceptor patches fetch and XMLHttpRequest', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain('window.fetch');
        expect(out).toContain('XMLHttpRequest.prototype.open');
    });

    it('interceptor stubs WebSocket for HMR protocols', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain('NoopWS');
        expect(out).toContain('vite-hmr');
    });
});

// Phase 2.5 (specs/preview-nextjs-turbopack-hydration/): Next.js App Router /
// Turbopack uses paths inside __next_f.push as resolver keys that must remain
// in their canonical "/_next/..." form so BACKEND.registerChunk's `chunkUrl =
// getChunkRelativeUrl(chunkPath)` matches the resolver created at fetch time.
// We deliberately do NOT rewrite these paths. Instead, the interceptor's
// HTMLScriptElement.src setter patch (below) redirects the actual fetch
// through the proxy while preserving the canonical attribute value.
describe('rewriteHtml — inline <style> CSS url() rewriting', () => {
    it('rewrites url("/...") inside an inline <style> block', () => {
        const out = rewriteHtml('<style>.x{background:url("/img/bg.png")}</style>', PREFIX);
        expect(out).toContain(`url("${PREFIX}/img/bg.png")`);
    });

    it('handles multiple url() in one inline <style> block', () => {
        const out = rewriteHtml(
            '<style>.a{background:url("/a.png")}.b{background:url("/b.png")}</style>',
            PREFIX,
        );
        expect(out).toContain(`url("${PREFIX}/a.png")`);
        expect(out).toContain(`url("${PREFIX}/b.png")`);
    });

    it('leaves external / protocol-relative url() untouched', () => {
        const out = rewriteHtml(
            '<style>.a{background:url("https://cdn/x.png")}.b{background:url("//cdn/y.png")}</style>',
            PREFIX,
        );
        expect(out).toContain('url("https://cdn/x.png")');
        expect(out).toContain('url("//cdn/y.png")');
    });

    it('handles unquoted url(/...) form', () => {
        const out = rewriteHtml('<style>.x{background:url(/img/bg.png)}</style>', PREFIX);
        expect(out).toContain(`url(${PREFIX}/img/bg.png)`);
    });

    it('does not double-rewrite an already-prefixed url() (idempotent)', () => {
        const input = `<style>.x{background:url("${PREFIX}/img/bg.png")}</style>`;
        const out = rewriteHtml(input, PREFIX);
        expect(out).toContain(`url("${PREFIX}/img/bg.png")`);
        expect(out).not.toContain(`${PREFIX}${PREFIX}`);
    });
});

describe('rewriteHtml — RSC flight stream MUST NOT be rewritten (Phase 2.5)', () => {
    it('leaves \\"/_next/...\\" paths inside __next_f.push JSON unchanged', () => {
        const input = `<script>self.__next_f.push([1,"7:I[\\"/_next/static/chunks/app.js\\"]"])</script>`;
        const out = rewriteHtml(input, PREFIX);
        // The path inside the JSON-escaped script body must remain "/_next/..."
        // because Turbopack uses it as a resolver key.
        expect(out).toContain(`7:I[\\"/_next/static/chunks/app.js\\"]`);
        expect(out).not.toContain(`${PREFIX}/_next/static/chunks/app.js`);
    });

    it('leaves real-world Next.js RSC HL+I payload unchanged', () => {
        const input = `<script>self.__next_f.push([1,":HL[\\"/_next/static/chunks/%5Broot-of-the-server%5D__d56404ae._.css\\",\\"style\\"]\\n7:I[\\"/_next/static/chunks/953a0._.js\\"]"])</script>`;
        const out = rewriteHtml(input, PREFIX);
        expect(out).toContain(`HL[\\"/_next/static/chunks/%5Broot-of-the-server%5D__d56404ae._.css\\"`);
        expect(out).toContain(`I[\\"/_next/static/chunks/953a0._.js\\"]`);
    });

    it('does still rewrite external <script src="/_next/..."> attributes (ABS_PATH_ATTRS regression)', () => {
        const input = `<script src="/_next/static/foo.js"></script>`;
        const out = rewriteHtml(input, PREFIX);
        expect(out).toContain(`src="${PREFIX}/_next/static/foo.js"`);
    });
});

// Phase 3 (specs/preview-nextjs-turbopack-hydration/): multi-URL attributes
// like `srcset`, `imagesrcset` (lowercase HTML form) and `imageSrcSet`
// (React/JSX form) are comma-separated URL+descriptor pairs. ABS_PATH_ATTRS
// can't rewrite them as a single string — each URL token must be
// rewritten independently while preserving the descriptor (1x, 2x, 300w).
describe('rewriteHtml — srcset / imageSrcSet multi-URL rewriting (Phase 3)', () => {
    it('rewrites both URLs in a simple srcset attribute', () => {
        const out = rewriteHtml('<img srcset="/a.png 1x, /b.png 2x">', PREFIX);
        expect(out).toContain(`srcset="${PREFIX}/a.png 1x, ${PREFIX}/b.png 2x"`);
    });

    it('rewrites URLs in imageSrcSet (JSX camelCase form Next.js emits)', () => {
        const input = `<link rel="preload" as="image" imageSrcSet="/_next/image?url=%2Fx.png&amp;w=96 1x, /_next/image?url=%2Fx.png&amp;w=256 2x"/>`;
        const out = rewriteHtml(input, PREFIX);
        expect(out).toContain(`${PREFIX}/_next/image?url=%2Fx.png&amp;w=96 1x`);
        expect(out).toContain(`${PREFIX}/_next/image?url=%2Fx.png&amp;w=256 2x`);
    });

    it('rewrites URLs in srcSet (React JSX camelCase form on <img>) — the obid Image bug', () => {
        // React's renderToString outputs the JSX `srcSet` prop literally as
        // `srcSet="…"` in SSR HTML. Earlier regex matched lowercase srcset
        // only, so next/image SSR'd <img srcSet="…"> tags stayed unprefixed
        // — browser fetched from platform origin, images broke.
        const input =
            `<img data-nimg="1" srcSet="/_next/image?url=foo&amp;w=96 1x, /_next/image?url=foo&amp;w=256 2x" src="/x">`;
        const out = rewriteHtml(input, PREFIX);
        expect(out).toContain(`${PREFIX}/_next/image?url=foo&amp;w=96 1x`);
        expect(out).toContain(`${PREFIX}/_next/image?url=foo&amp;w=256 2x`);
    });

    it('rewrites URLs in imagesrcset (lowercase HTML form)', () => {
        const out = rewriteHtml(`<link rel="preload" as="image" imagesrcset="/a.png 1x, /b.png 2x">`, PREFIX);
        expect(out).toContain(`${PREFIX}/a.png 1x`);
        expect(out).toContain(`${PREFIX}/b.png 2x`);
    });

    it('leaves external + protocol-relative URLs untouched, rewrites absolute ones', () => {
        const out = rewriteHtml(
            `<img srcset="https://cdn.example.com/x.png 1x, //cdn/y.png 2x, /local.png 3x">`,
            PREFIX,
        );
        expect(out).toContain('https://cdn.example.com/x.png 1x');
        expect(out).toContain('//cdn/y.png 2x');
        expect(out).toContain(`${PREFIX}/local.png 3x`);
        // No double-prefix on protocol-relative
        expect(out).not.toContain(`${PREFIX}//cdn`);
    });

    it('preserves srcset URLs already prefixed (idempotent)', () => {
        const input = `<img srcset="${PREFIX}/a.png 1x">`;
        const out = rewriteHtml(input, PREFIX);
        expect(out).toContain(`srcset="${PREFIX}/a.png 1x"`);
        expect(out).not.toContain(`${PREFIX}${PREFIX}`);
    });

    it('handles a single URL without descriptor in srcset', () => {
        const out = rewriteHtml(`<img srcset="/only.png">`, PREFIX);
        expect(out).toContain(`srcset="${PREFIX}/only.png"`);
    });
});

describe('rewriteHtml — interceptor script src/href/setAttribute patches', () => {
    it('patches src setter on HTMLScriptElement / HTMLImageElement', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain(`patchSetter(HTMLScriptElement.prototype,'src')`);
        expect(out).toContain(`patchSetter(HTMLImageElement.prototype,'src')`);
    });

    it('patches href setter on HTMLLinkElement', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain(`patchSetter(HTMLLinkElement.prototype,'href')`);
    });

    it('setter delegates to rw() (or supplied transform) — covers every absolute / path', () => {
        // The rw() helper is already defined for fetch/XHR — reusing it makes
        // setter behavior symmetric and idempotent. Without this, user code
        // like `script.src = '/api/widget.js'` would bypass the proxy.
        // The patchSetter signature accepts an optional transform so srcset
        // variants can pass rwSet instead.
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain(`set:function(v){d.set.call(this,fn(v))}`);
        expect(out).toContain(`var fn=t||rw`);
    });

    it('narrows setAttribute patch to HTMLScript / HTMLLink / HTMLImage prototypes (no global Element.prototype patch)', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain(`patchSetAttr(HTMLScriptElement.prototype)`);
        expect(out).toContain(`patchSetAttr(HTMLLinkElement.prototype)`);
        expect(out).toContain(`patchSetAttr(HTMLImageElement.prototype)`);
        // Must NOT install on Element.prototype (would slow every setAttribute call)
        expect(out).not.toMatch(/Element\.prototype\.setAttribute\s*=/);
    });

    it('setAttribute patch covers src / href / action and is case-insensitive on attr name', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain(`(nl==='src'||nl==='href'||nl==='action')`);
        expect(out).toContain(`n.toLowerCase()`);
        expect(out).toContain(`v=rw(v)`);
    });

    it('installs rwSet helper for multi-URL srcset rewriting', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain(`function rwSet(v)`);
        // rwSet must use rw() per-URL token + preserve descriptors
        expect(out).toContain(`return rw(u)+d`);
    });

    it('patches srcset setter on HTMLImageElement + HTMLSourceElement with rwSet', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain(`patchSetter(HTMLImageElement.prototype,'srcset',rwSet)`);
        expect(out).toContain(`patchSetter(HTMLSourceElement.prototype,'srcset',rwSet)`);
    });

    it('setAttribute patch covers srcset / imagesrcset via rwSet', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain(`(nl==='srcset'||nl==='imagesrcset')`);
        expect(out).toContain(`v=rwSet(v)`);
    });

    it('installs a forward-compat sentinel that warns if Next.js / Turbopack does not hydrate', () => {
        // The sentinel exists to surface a clear console warning if a future
        // Next.js version changes the /_next/ chunk-loader contract that our
        // patches depend on, instead of silently failing to a black screen.
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain(`window.next&&window.next.turbopack`);
        expect(out).toContain(`script[src*="_next/static/chunks"]`);
        expect(out).toContain(`Next.js / Turbopack hydration did not complete`);
        // 8s budget — long enough that real hydration finishes first.
        expect(out).toContain(`8000`);
    });

    it('keeps HTMLScriptElement.getAttribute(src) strip narrow to /_next/ (Turbopack-specific)', () => {
        // Stripping the prefix back is only needed for Turbopack's
        // getPathFromScript, which expects the canonical "/_next/" form.
        // For user-code paths like /api/foo, callers expect what they set.
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain(`HTMLScriptElement.prototype.getAttribute=function`);
        expect(out).toContain(`v.indexOf(P+'/_next/')===0`);
        expect(out).toContain(`v.slice(P.length)`);
    });
});

describe('rewriteHtml — interceptor window.location patches (Phase B escape plug)', () => {
    it('patches window.location.assign to route absolute paths through rw()', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain(`window.location.assign=function(u){return oAssign(rw(u))}`);
    });

    it('patches window.location.replace to route absolute paths through rw()', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain(`window.location.replace=function(u){return oReplace(rw(u))}`);
    });

    it('patches window.location.href setter on the Location prototype via rw()', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        // 정확한 한 줄을 박지 않고 setter 가 rw 를 통과시킨다는 invariant 만 확인
        expect(out).toMatch(/Object\.defineProperty\(.*?[Ll]ocation[\s\S]{0,200}set:[\s\S]{0,200}rw\(/);
    });

    it('wraps the location patches in try/catch for graceful fallback when redefine is blocked', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        // 식별 가능한 sentinel 한 줄로 try/catch 블록 존재 확인
        expect(out).toContain(`/* location-patch */`);
    });
});

describe('rewriteHtml — <meta http-equiv="refresh"> rewrite (Phase C escape plug)', () => {
    it('rewrites absolute-path url in standard form', () => {
        const out = rewriteHtml(
            '<html><head><meta http-equiv="refresh" content="0;url=/admin"></head></html>',
            PREFIX,
        );
        expect(out).toContain(`content="0;url=${PREFIX}/admin"`);
    });

    it('handles case-insensitive http-equiv / Refresh / URL', () => {
        const out = rewriteHtml(
            `<html><head><META HTTP-EQUIV='Refresh' CONTENT='5; URL=/admin'></head></html>`,
            PREFIX,
        );
        expect(out).toContain(`URL=${PREFIX}/admin`);
    });

    it('preserves cross-origin URLs', () => {
        const input = '<html><head><meta http-equiv="refresh" content="0;url=https://google.com/login"></head></html>';
        const out = rewriteHtml(input, PREFIX);
        expect(out).toContain('content="0;url=https://google.com/login"');
    });

    it('preserves protocol-relative URLs', () => {
        const input = '<html><head><meta http-equiv="refresh" content="0;url=//cdn.example/x"></head></html>';
        const out = rewriteHtml(input, PREFIX);
        expect(out).toContain('content="0;url=//cdn.example/x"');
    });

    it('does not double-prefix already-prefixed URLs (idempotent)', () => {
        const input = `<html><head><meta http-equiv="refresh" content="0;url=${PREFIX}/admin"></head></html>`;
        const out = rewriteHtml(input, PREFIX);
        expect(out).toContain(`content="0;url=${PREFIX}/admin"`);
        expect(out).not.toContain(`${PREFIX}${PREFIX}`);
    });
});

describe('rewriteJsCss', () => {
    it('rewrites ES import paths', () => {
        const out = rewriteJsCss(`import x from '/lib/x.js'`, PREFIX);
        expect(out).toContain(`'${PREFIX}/lib/x.js'`);
    });

    it('rewrites CSS url() references', () => {
        const out = rewriteJsCss(`.bg{background:url("/img/bg.png")}`, PREFIX);
        expect(out).toContain(`url("${PREFIX}/img/bg.png")`);
    });

    it('leaves protocol-relative paths untouched and does not double-prefix', () => {
        const input = `import a from '//cdn/lib.js'; import b from '${PREFIX}/local.js';`;
        const out = rewriteJsCss(input, PREFIX);
        expect(out).toContain("'//cdn/lib.js'");
        expect(out).toContain(`'${PREFIX}/local.js'`);
        expect(out).not.toContain(`${PREFIX}${PREFIX}`);
    });

    it('preserves existing query strings on rewritten paths', () => {
        const out = rewriteJsCss(`@import url("/theme.css?v=2")`, PREFIX);
        expect(out).toContain(`url("${PREFIX}/theme.css?v=2")`);
    });

    it('does not append ?ptoken= to rewritten URLs', () => {
        const input = `import x from '/a.js'; .bg{background:url("/img/b.png")}`;
        const out = rewriteJsCss(input, PREFIX);
        expect(out).not.toContain('ptoken=');
    });
});

// ============================================================================
// Phase 11B — rwPath / rwInput pure helpers
//
// Coverage gap discovered in Phase 11: the original `rw()` inside the inline
// interceptor required `typeof === 'string' && charAt(0) === '/'`. Apps using
// absolute-origin URLs, URL objects, or Request objects bypass the prefix
// rewrite and hit web-ui's `/api/*` directly → 404.
// ============================================================================

const P = '/v1/preview/m1/3000';
const ORIGIN = 'http://172.16.10.204:5174';

describe('rwPath — string path/URL rewriting', () => {
    it('prefixes a plain absolute path', () => {
        expect(rwPath('/api/x', P, ORIGIN)).toBe(`${P}/api/x`);
    });

    it('preserves query string when prefixing', () => {
        expect(rwPath('/api/x?y=1&z=2', P, ORIGIN)).toBe(`${P}/api/x?y=1&z=2`);
    });

    it('is idempotent — path already prefixed is returned as-is', () => {
        expect(rwPath(`${P}/api/x`, P, ORIGIN)).toBe(`${P}/api/x`);
    });

    it('leaves protocol-relative paths untouched', () => {
        expect(rwPath('//cdn.example.com/a.js', P, ORIGIN)).toBe('//cdn.example.com/a.js');
    });

    it('rewrites an absolute URL whose origin matches the page', () => {
        expect(rwPath(`${ORIGIN}/api/x`, P, ORIGIN)).toBe(`${ORIGIN}${P}/api/x`);
    });

    it('preserves query + hash on absolute-URL rewrite', () => {
        expect(rwPath(`${ORIGIN}/api/x?y=1#frag`, P, ORIGIN)).toBe(`${ORIGIN}${P}/api/x?y=1#frag`);
    });

    it('leaves cross-origin absolute URLs untouched', () => {
        expect(rwPath('https://other.com/api/x', P, ORIGIN)).toBe('https://other.com/api/x');
    });

    it('is idempotent on already-prefixed absolute URLs', () => {
        const url = `${ORIGIN}${P}/api/x`;
        expect(rwPath(url, P, ORIGIN)).toBe(url);
    });

    it('returns input on malformed URLs (e.g. relative without leading /)', () => {
        // `<base>` covers these in the browser; no rewrite at the interceptor.
        expect(rwPath('api/x', P, ORIGIN)).toBe('api/x');
    });

    it('returns input when typeof is not string (defensive)', () => {
        // Cast through unknown to test runtime guard.
        expect(rwPath(123 as unknown as string, P, ORIGIN)).toBe(123 as unknown as string);
    });
});

describe('rwInput — URL/Request object support', () => {
    it('rewrites a string input via rwPath', () => {
        expect(rwInput('/api/x', P, ORIGIN)).toBe(`${P}/api/x`);
    });

    it('rewrites a URL object (same origin) to a new URL', () => {
        const u = new URL(`${ORIGIN}/api/x`);
        const out = rwInput(u, P, ORIGIN);
        expect(out).toBeInstanceOf(URL);
        expect((out as URL).toString()).toBe(`${ORIGIN}${P}/api/x`);
    });

    it('returns the same URL object when already prefixed (no clone)', () => {
        const u = new URL(`${ORIGIN}${P}/api/x`);
        expect(rwInput(u, P, ORIGIN)).toBe(u);
    });

    it('returns cross-origin URL objects unchanged', () => {
        const u = new URL('https://other.com/api/x');
        expect(rwInput(u, P, ORIGIN)).toBe(u);
    });

    it('rewrites a Request object — wraps with new Request (URL replaced)', () => {
        const r = new Request(`${ORIGIN}/api/x`, { method: 'POST' });
        const out = rwInput(r, P, ORIGIN);
        expect(out).toBeInstanceOf(Request);
        expect((out as Request).url).toBe(`${ORIGIN}${P}/api/x`);
        expect((out as Request).method).toBe('POST');
    });

    it('returns the same Request when already prefixed', () => {
        const r = new Request(`${ORIGIN}${P}/api/x`);
        expect(rwInput(r, P, ORIGIN)).toBe(r);
    });

    it('passes through exotic non-string/URL/Request inputs', () => {
        const input = { foo: 'bar' };
        expect(rwInput(input, P, ORIGIN)).toBe(input);
    });
});
