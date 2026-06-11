/**
 * HTML / JS / CSS path rewriting for remote preview.
 *
 * Upstream dev servers emit absolute paths (e.g. `src="/main.js"`) that would
 * resolve to happy-server's own origin when served through the preview route.
 * This module rewrites those paths to include the per-request prefix
 * (`/v1/preview/{machineId}/{port}`) and injects a small browser-side shim
 * that:
 *
 * - rewrites `fetch(...)` / `XMLHttpRequest.open(...)` to go through the
 *   prefix so app-level API calls end up at the same dev server
 * - strips the prefix from `window.location.pathname` so SPA routers see
 *   clean paths
 * - stubs `WebSocket` for known HMR protocols (Vite / Next.js / Webpack)
 *
 * Auth is delivered via a per-preview HttpOnly cookie set by the relay on
 * the first response (see previewCookie.ts, Phase 9). The rewriter no
 * longer touches the auth secret — URLs stay clean so they don't leak into
 * browser history / referrer / DevTools / CDN cache keys.
 *
 * Kept in sync with the `preview-api-proxy` spec (R5 / R7).
 */

// Each regex captures three groups: (prefix/keyword, path, closing-delimiter)
// so the replacement can check `path.startsWith(prefix)` and avoid doubling
// an already-prefixed URL without a separate post-pass.
//
// Attribute list mirrors the locally-injected web-ui preview-proxy
// middleware (and the vite preview-proxy in aplus-dev-studio): standard
// fetchable URL attrs (src/href/action) plus the less common ones
// (`poster` on <video>, `data` on <object>, `formaction` on <button>,
// `background` on legacy <body>). Missing `poster`/`data`/`background`
// previously caused <video poster>, <object data>, and inline
// `style="background:url(/...)"` outside <style> blocks to leak through
// with absolute paths.
const ABS_PATH_ATTRS = /((?:src|href|action|poster|data|formaction|background)\s*=\s*["'])(\/(?!\/)[^"']*?)(["'])/g;
const ABS_PATH_IMPORT = /((?:from|import)\s*\(?\s*["'])(\/(?!\/)[^"']*?)(["'])/g;
const ABS_PATH_CSS_URL = /(url\(\s*["']?)(\/(?!\/)[^"')\s]*)(["']?\s*\))/g;
// Inline <style>...</style> blocks: rewrite CSS url() references inside.
// External CSS responses are handled separately by rewriteJsCss(), but
// embedded styles only show up when the rewriter walks the HTML body.
const INLINE_STYLE_BLOCK = /<style[^>]*>([\s\S]*?)<\/style>/gi;
// `style="..."` attribute values: same url() rewriting as <style> blocks,
// scoped to the attribute so we don't accidentally rewrite url("/...")
// string literals inside <script> tags (notably the RSC flight stream).
// Common in inline backgrounds (`style="background:url(/img/...)"`) and
// CSS-in-JS output that escapes to the SSR HTML.
const INLINE_STYLE_ATTR = /(style\s*=\s*["'])([^"']*)(["'])/gi;
// `srcset` / `imagesrcset` carry comma-separated URL+descriptor pairs
// (e.g. `/a.png 1x, /b.png 2x`). They don't fit ABS_PATH_ATTRS's
// single-URL shape, so we handle them with a dedicated pass that
// tokenizes each pair, rewrites the URL part if it's an absolute path,
// and preserves the descriptor verbatim.
//
// Case-insensitive on the attribute name: React's renderToString emits
// the JSX `srcSet` prop as `srcSet="…"` (capital S) in SSR HTML;
// next/image preload uses `imageSrcSet`. Browsers normalize these to
// lowercase on the DOM side, but our regex runs on the source string,
// so we need to match every case variant.
const MULTI_URL_ATTRS = /((?:srcset|imagesrcset)\s*=\s*["'])([^"']+)(["'])/gi;
// `<meta http-equiv="refresh" content="<delay>;url=<path>">` — when
// the path is absolute, browsers follow it against the iframe's current
// origin and escape the relay mount. Rewrite the url part (preserving
// delay / separators / quoting) so the refresh stays in-prefix.
// Case-insensitive on attribute names, http-equiv value, and `url=`
// keyword (HTML spec is case-insensitive). See specs/preview-relay-
// escape-plug/ Phase C.
const META_REFRESH = /(<meta\b[^>]*?http-equiv\s*=\s*["']refresh["'][^>]*?content\s*=\s*["'][^"']*?url\s*=\s*)(\/(?!\/)[^"']*)/gi;
function rewriteSrcSetValue(value: string, prefix: string): string {
    return value
        .split(',')
        .map((part) => {
            const trimmed = part.trim();
            if (!trimmed) return part;
            const spaceIdx = trimmed.search(/\s/);
            const url = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
            const descriptor = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx);
            // Only rewrite absolute paths starting with `/` but not `//`
            const shouldRewrite =
                url.startsWith('/') && !url.startsWith('//') && !url.startsWith(prefix);
            const rewritten = shouldRewrite ? `${prefix}${url}` : url;
            return `${rewritten}${descriptor}`;
        })
        .join(', ');
}
// NOTE on RSC flight stream: Next.js App Router emits the React Server
// Components flight stream as inline <script>self.__next_f.push([1, "<JSON>"])</script>
// containing absolute /_next/... paths inside `I[...]` import directives.
// We deliberately do NOT rewrite those paths even though they "look like"
// absolute URLs — the Turbopack runtime uses them as resolver keys that
// must match `getChunkRelativeUrl(chunkPath) === "/_next/" + chunkPath`.
// Rewriting them to `/v1/preview/.../3001/_next/...` causes the resolver
// to wait on a key that BACKEND.registerChunk never resolves, silently
// stalling hydration. See specs/preview-nextjs-turbopack-hydration/
// Phase 2.5 for the diagnosis. The actual fetch is redirected through
// the proxy via the interceptor's HTMLScriptElement.src setter patch.

function makeReplacer(prefix: string) {
    return (_match: string, pre: string, path: string, tail: string): string => {
        const prefixed = path.startsWith(prefix) ? path : `${prefix}${path}`;
        return `${pre}${prefixed}${tail}`;
    };
}

// ============================================================================
// Phase 11B — interceptor input coverage
//
// The runtime interceptor injected into rewritten HTML uses these two pure
// functions to decide how to rewrite a URL/input given the per-preview
// `prefix` and the page's `origin`. They are exported (and tested directly)
// so the dual-implementation drift problem from earlier specs can't recur:
// `buildInterceptorScript` embeds them verbatim via `.toString()`.
//
// Constraints these functions operate under:
//   - Browser runtime (no Node-only APIs)
//   - Must handle: string path / absolute URL (same origin) / `URL` / `Request`
//   - Idempotent: a value that already carries the prefix is returned as-is
//   - Body-preserving for Request (wraps via `new Request(rewrittenUrl, original)`)
// ============================================================================

export function rwPath(u: string, P: string, ORIGIN: string): string {
    if (typeof u !== 'string') return u as unknown as string;
    if (u.charAt(0) === '/') {
        if (u.charAt(1) === '/') return u;          // protocol-relative
        return u.indexOf(P) === 0 ? u : P + u;
    }
    try {
        const parsed = new URL(u);
        const token = parsed.searchParams.get('ptoken');
        if (token) {
            const slash = token.indexOf('/');
            if (slash > 0) {
                const pathTail = token.slice(slash);
                parsed.searchParams.set('ptoken', token.slice(0, slash));
                parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}${pathTail}`;
                return parsed.toString();
            }
        }
        if (parsed.origin !== ORIGIN) return u;
        const path = parsed.pathname + parsed.search + parsed.hash;
        if (path.indexOf(P) === 0) return u;
        return parsed.origin + P + path;
    } catch {
        return u;
    }
}

export function rwInput(i: unknown, P: string, ORIGIN: string): unknown {
    if (typeof i === 'string') return rwPath(i, P, ORIGIN);
    try {
        if (typeof Request !== 'undefined' && i instanceof Request) {
            const ru = rwPath(i.url, P, ORIGIN);
            return ru === i.url ? i : new Request(ru, i);
        }
        if (typeof URL !== 'undefined' && i instanceof URL) {
            const s = i.toString();
            const ru = rwPath(s, P, ORIGIN);
            return ru === s ? i : new URL(ru);
        }
    } catch {
        // Fall through — non-matching exotic input.
    }
    return i;
}

export function rewriteJsCss(text: string, prefix: string): string {
    const rep = makeReplacer(prefix);
    return text
        .replace(ABS_PATH_IMPORT, rep)
        .replace(ABS_PATH_CSS_URL, rep);
}

export function rewriteHtml(html: string, prefix: string): string {
    const rep = makeReplacer(prefix);
    let out = html
        .replace(META_REFRESH, (match, head: string, path: string) => {
            // idempotent: skip if already prefixed
            if (path === prefix || path.startsWith(prefix + '/')) return match;
            return `${head}${prefix}${path}`;
        })
        .replace(ABS_PATH_ATTRS, rep)
        .replace(ABS_PATH_IMPORT, rep)
        .replace(MULTI_URL_ATTRS, (_match, head: string, list: string, tail: string) =>
            `${head}${rewriteSrcSetValue(list, prefix)}${tail}`,
        )
        .replace(INLINE_STYLE_BLOCK, (match, css: string) => {
            const rewritten = css.replace(ABS_PATH_CSS_URL, rep);
            return rewritten === css ? match : match.replace(css, rewritten);
        })
        .replace(INLINE_STYLE_ATTR, (match, head: string, css: string, tail: string) => {
            const rewritten = css.replace(ABS_PATH_CSS_URL, rep);
            return rewritten === css ? match : `${head}${rewritten}${tail}`;
        });
  
    // <base> pins the document base URL so relative-path resources
    // (`<script src="app.js">`) survive the interceptor's history.replaceState.
    const baseHref = `<base href="${prefix}/">`;
    // Inspector bridge — listen for `inspector-enable`/`inspector-disable`
    // postMessages from the studio parent window, render a hover overlay,
    // post `inspector-select` back on click. Cross-origin relay 케이스에서
    // studio 가 iframe 의 contentDocument 에 inject 못 하므로 happy-server
    // 가 응답 HTML 에 미리 박아준다. enabled=false 로 시작 — 사용자가
    // 토글하기 전까진 완전 무영향.
    const headInjection = baseHref + buildInterceptorScript(prefix) + buildInspectorBridgeScript();
    if (out.includes('<head>')) {
        out = out.replace('<head>', `<head>${headInjection}`);
    } else if (out.includes('<html>')) {
        out = out.replace('<html>', `<html>${headInjection}`);
    } else {
        out = headInjection + out;
    }
    return out;
}

function buildInterceptorScript(prefix: string): string {
    // Kept as a single string so the rewriter doesn't accidentally patch its
    // own path literals. Escape single quotes in prefix so the embedded
    // `var P='…'` stays syntactically valid.
    const p = prefix.replace(/'/g, "\\'");
    // Phase 11B: inject the same rwPath / rwInput pure helpers used by the
    // unit tests. `Function.prototype.toString()` returns the compiled JS
    // source so the runtime helpers and the tested helpers stay in lockstep
    // (no parallel implementations to drift).
    const rwPathSource = rwPath.toString();
    const rwInputSource = rwInput.toString();
    return (
        `<script>(function(){` +
        `var P='${p}';` +
        `var ORIGIN=window.location.origin;` +
        `${rwPathSource};` +
        `${rwInputSource};` +
        `function rw(u){return rwPath(u,P,ORIGIN)}` +
        `function rwIn(i){return rwInput(i,P,ORIGIN)}` +
        `var loc=window.location.pathname;` +
        `if(loc.indexOf(P)===0){history.replaceState(null,'',loc.slice(P.length)||'/')}` +
        `var _WS=window.WebSocket;` +
        `function NoopWS(){` +
        `this.readyState=1;this.protocol='';this.extensions='';this.bufferedAmount=0;this.binaryType='blob';` +
        `this.onopen=null;this.onclose=null;this.onmessage=null;this.onerror=null;` +
        `this.send=function(){};this.close=function(){this.readyState=3};` +
        `var self=this;this._listeners={};` +
        `this.addEventListener=function(t,fn){if(!self._listeners[t])self._listeners[t]=[];self._listeners[t].push(fn)};` +
        `this.removeEventListener=function(t,fn){if(self._listeners[t])self._listeners[t]=self._listeners[t].filter(function(f){return f!==fn})};` +
        `this.dispatchEvent=function(e){var ls=self._listeners[e.type]||[];ls.forEach(function(fn){fn(e)});return true};` +
        `setTimeout(function(){if(self.onopen)self.onopen({type:'open'});self.dispatchEvent({type:'open'})},0)` +
        `}` +
        `NoopWS.CONNECTING=0;NoopWS.OPEN=1;NoopWS.CLOSING=2;NoopWS.CLOSED=3;` +
        `window.WebSocket=function(u,p){` +
        `if(p==='vite-hmr'||p==='vite-ping'||` +
        `(u&&(u.indexOf('__vite')!==-1||u.indexOf('/_next/webpack')!==-1||u.indexOf('hot-update')!==-1)))return new NoopWS();` +
        `u=rw(u);return p?new _WS(u,p):new _WS(u)};` +
        `window.WebSocket.prototype=_WS.prototype;` +
        `window.WebSocket.CONNECTING=0;window.WebSocket.OPEN=1;window.WebSocket.CLOSING=2;window.WebSocket.CLOSED=3;` +
        // Phase 11B: rwIn handles string / URL / Request — covers fetch
        // callers that don't pass plain string paths (e.g. apps using
        // `fetch(\`\${origin}/api/x\`)`, `fetch(new URL(...))`, or
        // `fetch(new Request(...))`). Without this, those calls bypass
        // the prefix and hit web-ui's /api/* root with no matching
        // middleware → 404.
        `var oF=window.fetch;window.fetch=function(i,n){return oF.call(this,rwIn(i),n)};` +
        `var oO=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=rwIn(u);return oO.apply(this,arguments)};` +
        // rwSet: multi-URL form of rw() for srcset / imagesrcset attribute
        // values. Each comma-separated entry is "URL descriptor?" (e.g.
        // "/_next/image?... 1x"); rewrite the URL part only and keep the
        // descriptor verbatim.
        `function rwSet(v){` +
        `if(typeof v!=='string')return v;` +
        `return v.split(',').map(function(p){` +
        `var t=p.trim();if(!t)return p;` +
        `var i=t.search(/\\s/);` +
        `var u=i===-1?t:t.slice(0,i);` +
        `var d=i===-1?'':t.slice(i);` +
        `return rw(u)+d` +
        `}).join(', ')};` +
        // Phase 2.5 / 3 / refactor for Next.js + general resource loading:
        //
        // (a) src/href setter patches on HTMLScriptElement / HTMLLinkElement /
        //     HTMLImageElement: when JS code does `el.src = '/foo'`, route
        //     the actual fetch through the proxy. Uses the same rw() helper
        //     as fetch/XHR so behavior is symmetric and idempotent — covers
        //     not just /_next/ but every absolute /... path (e.g. user code
        //     like `script.src = '/api/widget.js'`).
        //
        // (b) setAttribute shadow on the SAME three prototypes (not on the
        //     base Element.prototype). React's RSC reader uses
        //     `link.setAttribute('href', '/_next/...')` for HL[] preload
        //     directives — the property setter we patched in (a) doesn't
        //     fire for setAttribute. Narrowing to specific subclasses
        //     avoids paying the check cost on every <div>/<svg>/...
        //     setAttribute call.
        //
        // (c) getAttribute('src') strip on HTMLScriptElement only — kept
        //     narrow to /_next/ because Turbopack's getPathFromScript is
        //     the only known caller that relies on the canonical form.
        //     See specs/preview-nextjs-turbopack-hydration/ Phase 2.5.
        // patchSetter accepts an optional transform fn — defaults to rw()
        // (single-URL). srcset variants pass rwSet instead.
        `function patchSetter(proto,attr,t){` +
        `var d=Object.getOwnPropertyDescriptor(proto,attr);if(!d||!d.set)return;` +
        `var fn=t||rw;` +
        `Object.defineProperty(proto,attr,{configurable:true,` +
        `get:function(){return d.get.call(this)},` +
        `set:function(v){d.set.call(this,fn(v))}})` +
        `}` +
        `function patchSetAttr(proto){` +
        `var oSA=proto.hasOwnProperty('setAttribute')?proto.setAttribute:Element.prototype.setAttribute;` +
        `Object.defineProperty(proto,'setAttribute',{configurable:true,writable:true,` +
        `value:function(n,v){` +
        `var nl=typeof n==='string'?n.toLowerCase():n;` +
        `if(nl==='src'||nl==='href'||nl==='action')v=rw(v);` +
        `else if(nl==='srcset'||nl==='imagesrcset')v=rwSet(v);` +
        `return oSA.call(this,n,v)}})` +
        `}` +
        `patchSetter(HTMLScriptElement.prototype,'src');` +
        `patchSetter(HTMLLinkElement.prototype,'href');` +
        `patchSetter(HTMLImageElement.prototype,'src');` +
        // srcset setter on Image + Source (the <picture><source srcset>
        // form). React's next/image re-sets srcset after hydration via
        // the property; without this, the user sees broken images.
        `patchSetter(HTMLImageElement.prototype,'srcset',rwSet);` +
        `if(typeof HTMLSourceElement!=='undefined')patchSetter(HTMLSourceElement.prototype,'srcset',rwSet);` +
        `patchSetAttr(HTMLScriptElement.prototype);` +
        `patchSetAttr(HTMLLinkElement.prototype);` +
        `patchSetAttr(HTMLImageElement.prototype);` +
        `if(typeof HTMLSourceElement!=='undefined')patchSetAttr(HTMLSourceElement.prototype);` +
        // Phase B (specs/preview-relay-escape-plug/): patch
        // window.location writes — href setter, assign(), replace() —
        // so JS-driven navigation routes through rw() and stays inside
        // the preview mount instead of escaping to the relay origin.
        // Wrapped in try/catch: some browsers / strict-mode CSP refuse
        // to redefine Location.prototype.href; we silently fall back
        // (the other interceptors still apply).
        `try{/* location-patch */` +
        `var oAssign=window.location.assign.bind(window.location);` +
        `var oReplace=window.location.replace.bind(window.location);` +
        `window.location.assign=function(u){return oAssign(rw(u))};` +
        `window.location.replace=function(u){return oReplace(rw(u))};` +
        `var lp=Object.getPrototypeOf(window.location);` +
        `var ld=lp&&Object.getOwnPropertyDescriptor(lp,'href');` +
        `if(ld&&ld.set){Object.defineProperty(window.location,'href',{configurable:true,` +
        `get:function(){return ld.get.call(window.location)},` +
        `set:function(v){ld.set.call(window.location,rw(v))}})}` +
        `}catch(_){}` +
        `var oGA=Element.prototype.getAttribute;` +
        `HTMLScriptElement.prototype.getAttribute=function(n){` +
        `var v=oGA.call(this,n);` +
        `if(n==='src'&&typeof v==='string'&&v.indexOf(P+'/_next/')===0)return v.slice(P.length);` +
        `return v};` +
        // Forward-compat sentinel: our setter/getAttribute patches depend on
        // Turbopack's runtime stripping a hardcoded "/_next/" prefix in
        // getPathFromScript. If a future Next.js version changes that path
        // (or the chunk loader internals), our patches silently no-op and
        // hydration stalls — exactly the failure mode that started this
        // saga. After page load, check whether a Next.js + Turbopack page
        // hydrated. If not, surface a warning instead of a silent black
        // screen. False-positive guards: only fire if the page actually
        // shipped Turbopack chunk scripts (indicator that it IS a Next.js
        // app), and only if window.next.turbopack was never set.
        `setTimeout(function(){` +
        `try{` +
        `if(window.next&&window.next.turbopack)return;` +
        `if(!document.querySelector('script[src*="_next/static/chunks"]'))return;` +
        `console.warn('[happy-preview] Next.js / Turbopack hydration did not complete within 8s through the preview proxy. ' +` +
        `'This usually means the runtime\\'s chunk-loader contract changed and our /_next/ patch needs to be revisited. ' +` +
        `'See specs/preview-nextjs-turbopack-hydration/ for the original diagnosis.')` +
        `}catch(_){}` +
        `},8000);` +
        `})()</script>`
    );
}

/**
 * Inspector bridge — studio (parent) 가 cross-origin 의 relay iframe 안
 * contentDocument 에 직접 inject 못 하므로 happy-server 가 응답 HTML 에
 * 미리 박아준다. enabled=false 로 시작 — 'inspector-enable' postMessage 가
 * 도착해야 hover/click 이 활성. studio 가 토글 OFF 후엔 'inspector-disable'.
 *
 * postMessage 프로토콜 (studio web-ui 의 inspectorBridgeScript.ts 와 동일):
 *  - inbound : 'inspector-enable' | 'inspector-disable'
 *  - outbound: 'inspector-select' { tag, attrs, textContent, selector,
 *              label, clickX, clickY, rect }
 *
 * 본문은 studio 측 src/lib/inspectorBridgeScript.ts 의 INSPECTOR_BRIDGE_SCRIPT
 * 와 동기화 유지 필요 — drift 시 두 측 모두 일관 갱신.
 */
function buildInspectorBridgeScript(): string {
    return (
        `<script>(function(){` +
        `var enabled=false;var overlay=null;var tooltip=null;var lastTarget=null;` +
        `function createOverlay(){` +
        `overlay=document.createElement('div');overlay.id='__inspector_overlay';` +
        `overlay.style.cssText='position:fixed;pointer-events:none;z-index:999999;border:2px solid #3b82f6;background:rgba(59,130,246,0.08);transition:all 0.1s ease;display:none;';` +
        `document.body.appendChild(overlay);` +
        `tooltip=document.createElement('div');tooltip.id='__inspector_tooltip';` +
        `tooltip.style.cssText='position:fixed;z-index:1000000;pointer-events:none;background:#1e293b;color:#e2e8f0;font:11px/1.4 monospace;padding:2px 6px;border-radius:3px;white-space:nowrap;display:none;';` +
        `document.body.appendChild(tooltip);` +
        `}` +
        `function getSelector(el){` +
        `if(el.id)return '#'+el.id;` +
        `var tag=el.tagName.toLowerCase();` +
        `if(el.className&&typeof el.className==='string'){` +
        `var cls=el.className.trim().split(/\\s+/).filter(function(c){return c&&c.indexOf('__inspector')===-1;});` +
        `if(cls.length>0)return tag+'.'+cls.join('.');` +
        `}` +
        `var parent=el.parentElement;` +
        `if(!parent||parent===document.body)return tag;` +
        `var siblings=Array.from(parent.children).filter(function(c){return c.tagName===el.tagName;});` +
        `if(siblings.length===1)return getSelector(parent)+' > '+tag;` +
        `var idx=siblings.indexOf(el)+1;` +
        `return getSelector(parent)+' > '+tag+':nth-child('+idx+')';` +
        `}` +
        `function getLabel(el){` +
        `var tag=el.tagName.toLowerCase();var label=tag;` +
        `if(el.id)label+='#'+el.id;` +
        `if(el.className&&typeof el.className==='string'){` +
        `var cls=el.className.trim().split(/\\s+/).filter(function(c){return c&&c.indexOf('__inspector')===-1;});` +
        `if(cls.length>0)label+='.'+cls.slice(0,3).join('.');` +
        `}` +
        `return label;` +
        `}` +
        `function isIgnored(el){` +
        `return !el||el===document.body||el===document.documentElement||(el.id&&el.id.indexOf('__inspector')===0);` +
        `}` +
        `function hideOverlay(){` +
        `if(overlay)overlay.style.display='none';` +
        `if(tooltip)tooltip.style.display='none';` +
        `lastTarget=null;` +
        `}` +
        `function onMove(e){` +
        `if(!enabled)return;` +
        `var el=e.target;` +
        `if(isIgnored(el)){hideOverlay();return;}` +
        `lastTarget=el;` +
        `var rect=el.getBoundingClientRect();` +
        `overlay.style.top=rect.top+'px';overlay.style.left=rect.left+'px';` +
        `overlay.style.width=rect.width+'px';overlay.style.height=rect.height+'px';` +
        `overlay.style.display='block';` +
        `tooltip.textContent=getLabel(el);` +
        `tooltip.style.left=Math.min(rect.left,window.innerWidth-200)+'px';` +
        `tooltip.style.top=Math.max(0,rect.top-22)+'px';` +
        `tooltip.style.display='block';` +
        `}` +
        `function onClick(e){` +
        `if(!enabled)return;` +
        `var el=e.target;` +
        `if(isIgnored(el))return;` +
        `e.preventDefault();e.stopPropagation();` +
        `var text=(el.textContent||'').trim().slice(0,80);` +
        `var tag=el.tagName.toLowerCase();var attrs='';` +
        `if(el.id)attrs+=' id="'+el.id+'"';` +
        `if(el.className&&typeof el.className==='string'){` +
        `var cls=el.className.trim().split(/\\s+/).filter(function(c){return c.indexOf('__inspector')===-1;}).join(' ');` +
        `if(cls)attrs+=' class="'+cls+'"';` +
        `}` +
        `var rect=el.getBoundingClientRect();` +
        `parent.postMessage({` +
        `type:'inspector-select',tag:tag,attrs:attrs,textContent:text,` +
        `selector:getSelector(el),label:getLabel(el),` +
        `clickX:e.clientX,clickY:e.clientY,` +
        `rect:{top:rect.top,left:rect.left,width:rect.width,height:rect.height}` +
        `},'*');` +
        `}` +
        `window.addEventListener('message',function(e){` +
        `if(e.data&&e.data.type==='inspector-enable'){` +
        `enabled=true;if(!overlay)createOverlay();document.body.style.cursor='crosshair';` +
        `}` +
        `if(e.data&&e.data.type==='inspector-disable'){` +
        `enabled=false;hideOverlay();document.body.style.cursor='';` +
        `}` +
        `});` +
        `document.addEventListener('mousemove',onMove,true);` +
        `document.addEventListener('click',onClick,true);` +
        `})()</script>`
    );
}
