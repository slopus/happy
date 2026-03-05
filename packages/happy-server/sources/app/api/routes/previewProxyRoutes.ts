import { type Fastify } from '../types';
import { readFileSync, existsSync, statSync, createReadStream } from 'fs';
import { resolve, extname } from 'path';
import { hostname } from 'os';
import http from 'http';
import jwt from 'jsonwebtoken';
import { auth } from '@/app/auth/auth';

// ── Docker-aware localhost resolver ──────────────────────────────

// Cache: published port → internal address (e.g. "172.19.0.5:80")
const portCache = new Map<number, { addr: string; expires: number }>();
const CACHE_TTL = 60_000; // 1 minute

// Our own container networks (detected once)
let ownNetworks: string[] | null = null;

function dockerGet(path: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = http.request({
            socketPath: '/var/run/docker.sock',
            path: encodeURI(path),
            method: 'GET',
            timeout: 3000,
        }, (res) => {
            let data = '';
            res.on('data', (chunk: string) => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch { reject(new Error('Docker API parse error')); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
    });
}

async function getOwnNetworks(): Promise<string[]> {
    if (ownNetworks) return ownNetworks;
    try {
        const hn = hostname(); // container ID (short)
        const all: any[] = await dockerGet('/containers/json');
        for (const c of all) {
            const idMatch = c.Id?.startsWith(hn);
            const nameMatch = c.Names?.some((n: string) => n.includes('llmchat-server'));
            if (idMatch || nameMatch) {
                ownNetworks = Object.keys(c.NetworkSettings?.Networks || {});
                return ownNetworks;
            }
        }
    } catch {}
    ownNetworks = [];
    return ownNetworks;
}

async function resolveDockerPort(port: number): Promise<string | null> {
    const cached = portCache.get(port);
    if (cached && cached.expires > Date.now()) return cached.addr;
    try {
        const containers: any[] = await dockerGet(`/containers/json?filters={"publish":["${port}"]}`);
        if (!containers?.length) return null;
        const container = containers[0];
        const networks = container.NetworkSettings?.Networks || {};
        const myNets = await getOwnNetworks();
        // Find a shared network
        for (const net of myNets) {
            const netInfo = networks[net];
            if (netInfo?.IPAddress) {
                // Find internal port
                const ports: any[] = container.Ports || [];
                const mapping = ports.find((p: any) => p.PublicPort === port);
                const internalPort = mapping?.PrivatePort || port;
                const addr = `${netInfo.IPAddress}:${internalPort}`;
                portCache.set(port, { addr, expires: Date.now() + CACHE_TTL });
                return addr;
            }
        }
        // No shared network — try container's first available IP (don't cache, may improve later)
        for (const netInfo of Object.values(networks) as any[]) {
            if (netInfo.IPAddress) {
                const ports: any[] = container.Ports || [];
                const mapping = ports.find((p: any) => p.PublicPort === port);
                const internalPort = mapping?.PrivatePort || port;
                return `${netInfo.IPAddress}:${internalPort}`;
            }
        }
    } catch {}
    return null;
}

// Fallback: host gateway IP from /proc/net/route
const DOCKER_HOST_IP = (() => {
    try {
        const routes = readFileSync('/proc/net/route', 'utf8');
        for (const line of routes.split('\n').slice(1)) {
            const cols = line.split('\t');
            if (cols[1] === '00000000' && cols[2]) {
                const hex = cols[2];
                const ip = [0, 2, 4, 6].map(i => parseInt(hex.slice(i, i + 2), 16)).reverse().join('.');
                return ip;
            }
        }
        return null;
    } catch { return null; }
})();

async function resolveHost(host: string): Promise<string> {
    const m = host.match(/^(localhost|127\.0\.0\.1)(?::(\d+))?$/);
    if (!m) return host;
    const port = m[2] ? parseInt(m[2]) : 80;
    // Try Docker socket first
    const dockerAddr = await resolveDockerPort(port);
    if (dockerAddr) return dockerAddr;
    // Fallback to gateway IP
    if (DOCKER_HOST_IP) return host.replace(/^(localhost|127\.0\.0\.1)/, DOCKER_HOST_IP);
    return host;
}

// ── Monitor auth ──────────────────────────────────────────────────
const MONITOR_PASSWORD = process.env.MONITOR_PASSWORD || '';
const MONITOR_JWT_EXPIRY = 30 * 24 * 60 * 60; // 30 days
const WEBAPP_URL = process.env.WEBAPP_URL || '';

function parseCookie(header: string | undefined, name: string): string | null {
    if (!header) return null;
    const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
}

function verifyMonitorToken(token: string): boolean {
    if (!MONITOR_PASSWORD) return true;
    try {
        const payload = jwt.verify(token, MONITOR_PASSWORD) as any;
        return payload.type === 'monitor';
    } catch {
        return false;
    }
}

function isSelfOrigin(host: string): boolean {
    const blocked = ['app.304.systems'];
    if (WEBAPP_URL) {
        try { blocked.push(new URL(WEBAPP_URL).host); } catch {}
    }
    const normalized = host.replace(/:\d+$/, '');
    return blocked.some((b) => normalized === b.replace(/:\d+$/, ''));
}

// Inspector script injected into proxied HTML pages
// Supports multi-select: Shift+click adds to selection, regular click replaces
const INSPECTOR_SCRIPT = `<script data-happy-inspector="true">(function(){
'use strict';
var inspectMode=false,hoverOverlay=null,selectedOverlays=[],currentTarget=null;
function createOverlay(z,c){var e=document.createElement('div');e.style.cssText='position:fixed;pointer-events:none;box-sizing:border-box;transition:top .05s,left .05s,width .05s,height .05s;z-index:'+z+';background:'+c+';border:2px solid rgba(59,130,246,.8);display:none';document.documentElement.appendChild(e);return e}
function pos(o,r){o.style.top=r.top+'px';o.style.left=r.left+'px';o.style.width=r.width+'px';o.style.height=r.height+'px';o.style.display='block'}
function hide(o){if(o)o.style.display='none'}
function ensureHover(){if(!hoverOverlay)hoverOverlay=createOverlay(99998,'rgba(59,130,246,.15)')}
function clearSelectedOverlays(){selectedOverlays.forEach(function(o){o.parentElement&&o.parentElement.removeChild(o)});selectedOverlays=[]}
function addSelectedOverlay(r){var o=createOverlay(99999,'rgba(59,130,246,.25)');pos(o,r);selectedOverlays.push(o)}
function esc(s){return CSS&&CSS.escape?CSS.escape(s):s.replace(/([!"#$$%&'()*+,./:;<=>?@[\\\\\\]^{|}~])/g,'\\\\$1')}
function step(el){if(!el||el.nodeType!==1)return'';var t=el.tagName.toLowerCase();if(el.id)return t+'#'+esc(el.id);var c='';if(el.classList&&el.classList.length)c=[].slice.call(el.classList).map(function(x){return'.'+esc(x)}).join('');var p=el.parentElement,n='';if(p){var s=[].slice.call(p.children).filter(function(x){return x.tagName===el.tagName});if(s.length>1)n=':nth-of-type('+(s.indexOf(el)+1)+')'}return t+c+n}
function sel(el){var p=[];var c=el;while(c&&c!==document.documentElement&&c.nodeType===1){var s=step(c);if(!s)break;p.unshift(s);if(c.id)break;c=c.parentElement}return p.join(' > ')}
function ctx(el){var p=[];var x=el.parentElement;while(x&&x!==document.documentElement&&p.length<3){var t=x.tagName.toLowerCase();var c=x.classList&&x.classList.length?'.'+[].slice.call(x.classList).slice(0,2).join('.'):'';if(t+c)p.push(t+c);x=x.parentElement}return p.slice(0,2).join(' inside ')}
function send(d){var j=JSON.stringify(d);try{if(window.parent&&window.parent!==window){window.parent.postMessage(j,'*');return}}catch(e){}try{window.postMessage(j,'*')}catch(e){}}
function getElementData(t){var r=t.getBoundingClientRect();var oh=t.outerHTML||'';if(oh.length>2000)oh=oh.slice(0,2000)+'...';return{selector:sel(t),tag:t.tagName.toLowerCase(),classes:t.classList?[].slice.call(t.classList):[],id:t.id||null,text:(t.textContent||'').trim().slice(0,200),outerHTML:oh,parentContext:ctx(t),boundingBox:{x:Math.round(r.left+window.scrollX),y:Math.round(r.top+window.scrollY),width:Math.round(r.width),height:Math.round(r.height)}}}
document.addEventListener('mousemove',function(e){if(!inspectMode)return;var t=e.target;if(!t||t===hoverOverlay||selectedOverlays.indexOf(t)!==-1)return;currentTarget=t;ensureHover();pos(hoverOverlay,t.getBoundingClientRect())},{capture:true,passive:true});
document.addEventListener('mouseleave',function(){if(!inspectMode)return;hide(hoverOverlay);currentTarget=null},{capture:true,passive:true});
document.addEventListener('click',function(e){if(!inspectMode)return;var t=e.target;if(!t||t===hoverOverlay||selectedOverlays.indexOf(t)!==-1)return;e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();var d=getElementData(t);var r=t.getBoundingClientRect();addSelectedOverlay(r);d.type=selectedOverlays.length>1?'element-added':'element-selected';send(d)},{capture:true});
function setInspect(on){inspectMode=!!on;if(!inspectMode){hide(hoverOverlay);clearSelectedOverlays();currentTarget=null;document.documentElement.style.cursor=''}else{document.documentElement.style.cursor='crosshair'}}
window.addEventListener('message',function(e){var d=e.data;if(typeof d==='string'){try{d=JSON.parse(d)}catch(x){return}}if(!d||typeof d!=='object')return;if(d.type==='set-inspect-mode')setInspect(d.enabled);else if(d.type==='css-update'){var ts=Date.now();[].slice.call(document.querySelectorAll('link[rel="stylesheet"]')).forEach(function(l){var h=(l.href||'').replace(/([?&])v=\\d+/,'');l.href=h+(h.indexOf('?')===-1?'?':'&')+'v='+ts})}else if(d.type==='full-reload')window.location.reload()});
var hasHMR=typeof window.__vite_plugin_react_preamble_installed__!=='undefined'||typeof window.__NEXT_DATA__!=='undefined'||typeof window.webpackHotUpdate!=='undefined';
send({type:'hmr-status',hasHMR:hasHMR});
window.addEventListener('keydown',function(e){if(e.code==='MetaLeft'&&!e.repeat)send({type:'meta-key',state:'down'})},true);
window.addEventListener('keyup',function(e){if(e.code==='MetaLeft')send({type:'meta-key',state:'up'})},true);
window.addEventListener('blur',function(){send({type:'meta-key',state:'up'})},true);
})()</script>`;

/**
 * Full reverse proxy for the Preview Panel.
 *
 * URL scheme:  /v1/preview/<protocol>/<host>/<path>
 * Example:     /v1/preview/https/learn.304.systems/v1/auth/login
 *
 * For HTML responses the inspector script is injected and a <base> tag
 * is rewritten so that *all* relative URLs (scripts, styles, images,
 * fetch() calls) resolve back through this proxy — keeping the iframe
 * same-origin with the Happy app.
 */
// SSE relay: monitor POSTs events, app subscribes via GET (SSE)
type SSEClient = { id: number; reply: any };
let sseClients: SSEClient[] = [];
let sseIdCounter = 0;

function broadcastEvent(data: unknown) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    sseClients = sseClients.filter((client) => {
        try {
            client.reply.raw.write(payload);
            return true;
        } catch {
            return false; // dead connection
        }
    });
}

export function previewProxyRoutes(app: Fastify) {
    // Monitor auth middleware
    const monitorAuth = async (request: any, reply: any) => {
        if (!MONITOR_PASSWORD) return;
        // Sidebar requests carry a Bearer token — bypass monitor password
        const authHeader = request.headers.authorization as string | undefined;
        if (authHeader?.startsWith('Bearer ')) {
            try {
                const verified = await auth.verifyToken(authHeader.substring(7));
                if (verified) return;
            } catch {}
        }
        // Check monitor_token cookie
        const monitorToken = parseCookie(request.headers['cookie'] as string | undefined, 'monitor_token');
        if (monitorToken && verifyMonitorToken(monitorToken)) return;
        return reply.code(401).send({ error: 'Authentication required' });
    };

    // SSE stream — app subscribes to receive inspector events from monitor
    app.get('/v1/preview/events', { preHandler: monitorAuth }, async (request, reply) => {
        // HEAD requests used by monitor to check auth status
        if (request.method === 'HEAD') {
            return reply.code(200).send();
        }
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });
        reply.raw.write(':ok\n\n');

        const client: SSEClient = { id: ++sseIdCounter, reply };
        sseClients.push(client);

        // Keep-alive ping every 15s
        const keepAlive = setInterval(() => {
            try { reply.raw.write(':ping\n\n'); } catch { clearInterval(keepAlive); }
        }, 15000);

        request.raw.on('close', () => {
            clearInterval(keepAlive);
            sseClients = sseClients.filter((c) => c.id !== client.id);
        });
    });

    // Monitor posts inspector events here
    app.post('/v1/preview/events', { preHandler: monitorAuth }, async (request, reply) => {
        const data = request.body;
        if (!data || typeof data !== 'object') {
            return reply.code(400).send({ error: 'Invalid payload' });
        }
        broadcastEvent(data);
        return reply.send({ ok: true });
    });
    // Auth endpoint — verify monitor password, return JWT cookie
    app.post('/v1/preview/auth', async (request, reply) => {
        if (!MONITOR_PASSWORD) {
            return reply.send({ success: true });
        }
        const body = request.body as any;
        if (!body?.password || typeof body.password !== 'string') {
            return reply.code(400).send({ error: 'Password is required' });
        }
        if (body.password !== MONITOR_PASSWORD) {
            return reply.code(401).send({ error: 'Invalid password' });
        }
        const token = jwt.sign({ type: 'monitor' }, MONITOR_PASSWORD, { expiresIn: MONITOR_JWT_EXPIRY });
        const secure = process.env.NODE_ENV === 'production';
        reply.header('Set-Cookie',
            `monitor_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MONITOR_JWT_EXPIRY}${secure ? '; Secure' : ''}`
        );
        return reply.send({ success: true });
    });

    app.get('/v1/preview/:protocol/:host/*', async (request, reply) => {
        const { protocol, host } = request.params as { protocol: string; host: string };
        const rest = (request.params as any)['*'] || '';
        const queryString = request.url.includes('?')
            ? '?' + request.url.split('?').slice(1).join('?')
            : '';
        if (isSelfOrigin(host)) {
            return reply.code(403).send({ error: 'Cannot proxy to the Happy app itself' });
        }

        const resolvedHost = await resolveHost(host);
        const targetUrl = `${protocol}://${resolvedHost}/${rest}${queryString}`;

        try {
            const response = await fetch(targetUrl, {
                headers: {
                    'User-Agent': request.headers['user-agent'] || 'Mozilla/5.0 (Happy Preview)',
                    'Accept': request.headers['accept'] as string || '*/*',
                    'Accept-Language': request.headers['accept-language'] as string || 'en',
                    'Cookie': request.headers['cookie'] as string || '',
                },
                redirect: 'manual',
            });

            // Handle redirects: re-route through proxy so relative URLs resolve correctly
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location');
                if (location) {
                    const redirectUrl = new URL(location, targetUrl);
                    const proxyRedirect = `/v1/preview/${redirectUrl.protocol.replace(':', '')}/${redirectUrl.host}${redirectUrl.pathname}${redirectUrl.search}`;
                    return reply.code(302).header('Location', proxyRedirect).send();
                }
            }

            const contentType = response.headers.get('content-type') || '';

            // Pass through common headers
            const cacheControl = response.headers.get('cache-control');
            if (cacheControl) reply.header('Cache-Control', cacheControl);

            // Non-HTML: pass through (rewrite absolute url() in CSS)
            if (!contentType.includes('text/html')) {
                reply.header('Content-Type', contentType);
                if (contentType.includes('text/css')) {
                    let css = await response.text();
                    css = css.replace(/url\(\s*(['"]?)\/(?!v1\/preview\/)/g, `url($1/v1/preview/${protocol}/${host}/`);
                    return reply.send(css);
                }
                const buffer = Buffer.from(await response.arrayBuffer());
                return reply.send(buffer);
            }

            // HTML: inject inspector + rewrite base
            let html = await response.text();

            // The base URL for all relative paths — points back through our proxy
            const proxyBase = `/v1/preview/${protocol}/${host}/`;

            // Compute <base> href so relative URLs (scripts, images) resolve through the proxy
            // even after history.replaceState changes the visible URL for SPA routing
            const restDir = rest.endsWith('/') ? rest : rest.substring(0, rest.lastIndexOf('/') + 1);
            const baseHref = `${proxyBase}${restDir}`;
            // Remove any existing <base> and inject ours
            html = html.replace(/<base\s[^>]*>/gi, '');
            if (html.includes('<head>')) {
                html = html.replace('<head>', `<head><base href="${baseHref}">`);
            } else if (html.includes('<html>')) {
                html = html.replace('<html>', `<html><head><base href="${baseHref}"></head>`);
            }

            // Rewrite absolute paths in HTML attributes (src="/...", href="/...")
            // so that <script src="/_expo/...">, <link href="/_expo/..."> etc.
            // go through the proxy instead of hitting app.304.systems directly.
            html = html.replace(
                /((?:src|href|action)\s*=\s*["'])\/(?!v1\/preview\/)/gi,
                `$1${proxyBase}`
            );

            // Inject inspector before </head>
            if (html.includes('</head>')) {
                html = html.replace('</head>', INSPECTOR_SCRIPT + '</head>');
            } else if (html.includes('</body>')) {
                html = html.replace('</body>', INSPECTOR_SCRIPT + '</body>');
            } else {
                html += INSPECTOR_SCRIPT;
            }

            // Inject fetch/XHR patching + history patching for SPA router
            // This script patches fetch() and XMLHttpRequest so that absolute
            // paths like /v1/courses get routed through the proxy instead of
            // hitting the Happy server directly.
            // It also immediately sets the visible URL to the original path
            // so that the SPA router matches routes correctly.
            const originalPath = '/' + rest + queryString;
            const patchScript = `<script>(function(){
var P='${proxyBase.replace(/'/g, "\\'")}';
var OP='${originalPath.replace(/'/g, "\\'")}';
var _f=window.fetch;
window.fetch=function(u,o){
if(typeof u==='string'&&u.startsWith('/')&&!u.startsWith(P))u=P+u.slice(1);
else if(u instanceof Request){var nu=u.url;try{var p=new URL(nu);if(p.origin===location.origin&&p.pathname.startsWith('/')&&!p.pathname.startsWith(P)){u=new Request(P+p.pathname.slice(1)+p.search+p.hash,u)}}catch(e){}}
return _f.call(this,u,o)};
var _o=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){
if(typeof u==='string'&&u.startsWith('/')&&!u.startsWith(P))u=P+u.slice(1);
return _o.apply(this,[m,u].concat([].slice.call(arguments,2)))};
history.replaceState(null,'',OP);
function rw(s){return s.replace(/url\\(\\s*(['"]?)\\/(?!v1\\/preview\\/)/g,'url($1'+P)}
function rwUrl(v){return typeof v==='string'&&v.startsWith('/')&&!v.startsWith(P)?P+v.slice(1):v}
var _FF=window.FontFace;if(_FF){window.FontFace=function(f,s,d){if(typeof s==='string')s=rw(s);return new _FF(f,s,d)};window.FontFace.prototype=_FF.prototype}
var _iR=CSSStyleSheet.prototype.insertRule;CSSStyleSheet.prototype.insertRule=function(r,i){if(typeof r==='string')r=rw(r);return _iR.call(this,r,i)};
var _sa=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){if((n==='src'||n==='href'||n==='action')&&typeof v==='string')v=rwUrl(v);return _sa.call(this,n,v)};
['HTMLScriptElement','HTMLImageElement','HTMLSourceElement','HTMLVideoElement','HTMLAudioElement','HTMLIFrameElement'].forEach(function(t){var C=window[t];if(!C)return;var d=Object.getOwnPropertyDescriptor(C.prototype,'src');if(d&&d.set){Object.defineProperty(C.prototype,'src',{set:function(v){d.set.call(this,rwUrl(v))},get:d.get,configurable:true,enumerable:true})}});
var _ld=Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype,'href');if(_ld&&_ld.set){Object.defineProperty(HTMLLinkElement.prototype,'href',{set:function(v){_ld.set.call(this,rwUrl(v))},get:_ld.get,configurable:true,enumerable:true})}
function fixStyle(el){if(el&&el.tagName==='STYLE'&&el.textContent&&/url\\(\\s*['"]?\\//.test(el.textContent)){el.textContent=rw(el.textContent)}}
var _ac=Node.prototype.appendChild;Node.prototype.appendChild=function(c){if(c&&c.nodeType===1)fixStyle(c);return _ac.call(this,c)};
var _ib=Node.prototype.insertBefore;Node.prototype.insertBefore=function(c,r){if(c&&c.nodeType===1)fixStyle(c);return _ib.call(this,c,r)};
new MutationObserver(function(muts){muts.forEach(function(m){m.addedNodes.forEach(function(n){if(n.nodeType===1){if(n.tagName==='STYLE')fixStyle(n);if(n.querySelectorAll){n.querySelectorAll('style').forEach(fixStyle)}}})})}).observe(document.documentElement,{childList:true,subtree:true});
var _lr=location.replace.bind(location);location.replace=function(u){return _lr(rwUrl(u))};
var _la=location.assign.bind(location);location.assign=function(u){return _la(rwUrl(u))};
if(window.navigation){window.navigation.addEventListener('navigate',function(e){if(!e.canIntercept||e.hashChange||e.destination.sameDocument)return;try{var u=new URL(e.destination.url);if(u.origin===location.origin&&u.pathname.startsWith('/')&&!u.pathname.startsWith('/v1/preview/')){e.intercept({handler:function(){_lr(P+u.pathname.slice(1)+u.search+u.hash)}})}}catch(x){}})}
})()</script>`;

            if (html.includes('<head>')) {
                html = html.replace('<head>', '<head>' + patchScript);
            } else if (html.includes('<html>')) {
                html = html.replace('<html>', '<html><head>' + patchScript + '</head>');
            }

            reply.header('Content-Type', 'text/html; charset=utf-8');
            reply.header('X-Frame-Options', 'ALLOWALL');
            return reply.send(html);
        } catch (err: any) {
            const accept = request.headers['accept'] as string || '';
            if (accept.includes('text/html')) {
                reply.header('Content-Type', 'text/html; charset=utf-8');
                return reply.code(502).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Unavailable</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1a1e;color:#fff}.box{text-align:center}.box h2{margin-bottom:8px}.box p{color:#888;font-size:14px}</style></head><body><div class="box"><h2>Dev-server unavailable</h2><p>${err.message || 'Connection refused'}</p></div></body></html>`);
            }
            return reply.code(502).send({ error: 'Proxy error: ' + (err.message || 'Unknown') });
        }
    });

    // Also support POST/PUT/PATCH/DELETE for API calls through the proxy
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
        app[method]('/v1/preview/:protocol/:host/*', async (request, reply) => {
            const { protocol, host } = request.params as { protocol: string; host: string };
            const rest = (request.params as any)['*'] || '';
            const queryString = request.url.includes('?')
                ? '?' + request.url.split('?').slice(1).join('?')
                : '';
            if (isSelfOrigin(host)) {
                return reply.code(403).send({ error: 'Cannot proxy to the Happy app itself' });
            }

            const resolvedHost = await resolveHost(host);
            const targetUrl = `${protocol}://${resolvedHost}/${rest}${queryString}`;

            try {
                const headers: Record<string, string> = {
                    'User-Agent': request.headers['user-agent'] || 'Mozilla/5.0 (Happy Preview)',
                    'Accept': request.headers['accept'] as string || '*/*',
                    'Cookie': request.headers['cookie'] as string || '',
                };
                const ct = request.headers['content-type'] as string;
                if (ct) headers['Content-Type'] = ct;

                const response = await fetch(targetUrl, {
                    method: method.toUpperCase(),
                    headers,
                    body: request.body ? JSON.stringify(request.body) : undefined,
                    redirect: 'follow',
                });

                const contentType = response.headers.get('content-type') || '';
                reply.header('Content-Type', contentType);
                reply.status(response.status);
                const buffer = Buffer.from(await response.arrayBuffer());
                return reply.send(buffer);
            } catch (err: any) {
                return reply.code(502).send({ error: 'Proxy error: ' + (err.message || 'Unknown') });
            }
        });
    }

    // ── File preview: serve local files from the host filesystem ──────
    // Host root is mounted as /host-root (read-only)
    const MIME_MAP: Record<string, string> = {
        '.html': 'text/html', '.htm': 'text/html',
        '.css': 'text/css', '.js': 'application/javascript',
        '.json': 'application/json', '.txt': 'text/plain',
        '.md': 'text/plain', '.log': 'text/plain',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
        '.ico': 'image/x-icon', '.pdf': 'application/pdf',
        '.mp4': 'video/mp4', '.webm': 'video/webm',
        '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
        '.xml': 'application/xml', '.csv': 'text/csv',
        '.ts': 'text/plain', '.tsx': 'text/plain', '.jsx': 'text/plain',
        '.py': 'text/plain', '.sh': 'text/plain', '.yml': 'text/plain',
        '.yaml': 'text/plain', '.toml': 'text/plain', '.env': 'text/plain',
    };

    app.get('/v1/preview/file/*', async (request, reply) => {
        const rawPath = (request.params as any)['*'] || '';
        const virtualPath = resolve('/' + rawPath);

        // Map virtual path to host-mounted path
        const filePath = '/host-root' + virtualPath;

        if (!existsSync(filePath)) {
            return reply.code(404).send({ error: 'File not found: ' + virtualPath });
        }

        const stat = statSync(filePath);
        if (stat.isDirectory()) {
            const { readdirSync } = await import('fs');
            const entries = readdirSync(filePath, { withFileTypes: true });
            const items = entries.map((e) => {
                const name = e.name + (e.isDirectory() ? '/' : '');
                const href = '/v1/preview/file' + virtualPath + '/' + e.name;
                return `<li><a href="${href}">${name}</a></li>`;
            }).join('\n');
            reply.header('Content-Type', 'text/html; charset=utf-8');
            return reply.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${virtualPath}</title><style>body{font-family:system-ui;background:#1a1a1e;color:#fff;padding:20px}a{color:#6384FF;text-decoration:none}a:hover{text-decoration:underline}li{margin:4px 0;font-size:14px}h2{font-size:16px;color:#888;font-weight:normal}</style></head><body><h2>${virtualPath}</h2><ul>${items}</ul></body></html>`);
        }

        const ext = extname(filePath).toLowerCase();
        const contentType = MIME_MAP[ext] || 'application/octet-stream';
        reply.header('Content-Type', contentType);
        reply.header('Content-Length', stat.size);
        return reply.send(createReadStream(filePath));
    });
}
