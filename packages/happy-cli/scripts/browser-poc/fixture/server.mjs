import http from "node:http";
import { openSync, writeSync, fsyncSync, readFileSync, closeSync, existsSync } from "node:fs";
import { timingSafeEqual, randomUUID } from "node:crypto";
const { HARNESS_TOKEN, LEDGER_FILE } = process.env;
if (!HARNESS_TOKEN || !LEDGER_FILE) throw new Error("HARNESS_TOKEN and LEDGER_FILE are required");
const pagePort = Number(process.env.FIXTURE_PORT || 8080);
const controlPort = Number(process.env.CONTROL_PORT || 9099);
const barriers = /* @__PURE__ */ new Map(), faults = /* @__PURE__ */ new Map(), sessions = /* @__PURE__ */ new Map();
const key = (run, part) => `${run}\0${part}`;
const esc = (v) => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const script = (v) => JSON.stringify(String(v ?? "")).replaceAll("<", "\\u003c");
const html = (res, body2) => send(res, 200, `<!doctype html><meta charset="utf-8"><body>${body2}</body>`, "text/html; charset=utf-8");
const send = (res, status, body2, type = "application/json") => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body2 === "string" ? body2 : JSON.stringify(body2));
};
const redirect = (res, to) => {
  res.writeHead(302, { location: to });
  res.end();
};
const record = (entry) => {
  const fd = openSync(LEDGER_FILE, "a", 384);
  try {
    writeSync(fd, JSON.stringify({ ...entry, atMs: Date.now() }) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};
const entries = (run) => existsSync(LEDGER_FILE) ? readFileSync(LEDGER_FILE, "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x)).filter((x) => x.run === run) : [];
const body = async (req) => {
  let value = "";
  for await (const chunk of req) {
    value += chunk;
    if (value.length > 65536) throw new Error("body too large");
  }
  if (req.headers["content-type"]?.includes("application/json")) return JSON.parse(value || "{}");
  return Object.fromEntries(new URLSearchParams(value));
};
const auth = (req) => {
  const supplied = req.headers["x-harness-token"];
  const a = Buffer.from(Array.isArray(supplied) ? "" : supplied || "");
  const b = Buffer.from(HARNESS_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};
const originB = process.env.SITE_B_ORIGIN || `http://b.poc-two.test:${pagePort}`;
const originC = process.env.SITE_C_ORIGIN || `http://c.poc-three.test:${pagePort}`;
const cookie = (req) => Object.fromEntries((req.headers.cookie || "").split(";").map((x) => x.trim().split("=").map(decodeURIComponent)).filter((x) => x.length === 2));
const nextPath = (raw) => {
  try {
    const u = new URL(raw, "http://local");
    return u.origin === "http://local" ? u.pathname + u.search : "/";
  } catch {
    return "/";
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(Number(ms) || 0, 0), 3e4)));
http.createServer(async (req, res) => {
  try {
    if (!auth(req)) return send(res, 401, { error: "unauthorized" });
    const u = new URL(req.url, "http://control");
    if (req.method === "GET" && u.pathname === "/control/health") return send(res, 200, { ok: true });
    if (req.method === "GET" && u.pathname === "/control/ledger") return send(res, 200, { entries: entries(u.searchParams.get("run")) });
    if (req.method === "POST" && u.pathname === "/control/barrier/release") {
      const { run, key: k, nonce } = await body(req);
      if (!run || !k || !nonce) return send(res, 400, { error: "missing fields" });
      barriers.set(key(run, k), nonce);
      record({ kind: "barrier-release", run, key: k, nonce });
      return send(res, 200, { released: true });
    }
    if (req.method === "POST" && u.pathname === "/control/fault") {
      const { kind, mode, run, delayMs } = await body(req);
      if (!["risky", "answer"].includes(kind) || !run || kind === "risky" && !["normal", "hang", "drop-after-record"].includes(mode)) return send(res, 400, { error: "invalid fault" });
      faults.set(key(run, kind), { mode, delayMs: Number(delayMs ?? mode) || 0 });
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && u.pathname === "/control/reset") {
      const { run } = await body(req);
      if (!run) return send(res, 400, { error: "missing run" });
      for (const map of [barriers, faults]) for (const k of map.keys()) if (k.startsWith(`${run}\0`)) map.delete(k);
      const kept = existsSync(LEDGER_FILE) ? readFileSync(LEDGER_FILE, "utf8").split("\n").filter(Boolean).filter((x) => JSON.parse(x).run !== run) : [];
      const fd = openSync(LEDGER_FILE, "w", 384);
      try {
        writeSync(fd, kept.length ? kept.join("\n") + "\n" : "");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return send(res, 200, { reset: true });
    }
    send(res, 404, { error: "not found" });
  } catch {
    send(res, 400, { error: "bad request" });
  }
}).listen(controlPort, "0.0.0.0");
http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://fixture"), p = u.pathname, run = u.searchParams.get("run") || "", host = (req.headers.host || "").split(":")[0];
    const site = host.startsWith("b.") ? "b" : host.startsWith("c.") ? "c" : "a";
    if (p.startsWith("/control/")) return send(res, 404, { error: "not found" });
    if (p === "/marker" && ["a", "b"].includes(site)) return html(res, `<style>body{margin:0;height:100vh;background:#${esc((u.searchParams.get("color") || "fff").replace(/^#/, ""))};display:grid;place-items:center;font:72px sans-serif}</style><strong>${esc(u.searchParams.get("label"))}</strong>`);
    if (site === "c") return p === "/secret" ? html(res, `ABP-CANARY-FRAME-${esc(run)}`) : send(res, 404, { error: "not found" });
    if (site === "b") {
      if (p === "/frame-b") return html(res, `<button onclick="fetch('/api/click',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({run:${esc(script(run))},target:'B-frame'})})">Buy</button>`);
      if (p !== "/api/click") return send(res, 404, { error: "not found" });
    }
    if (p === "/api/barrier-state" && req.method === "GET") return send(res, 200, { released: barriers.has(key(run, u.searchParams.get("key"))), nonce: barriers.get(key(run, u.searchParams.get("key"))) ?? null });
    if (p === "/api/answer" && req.method === "POST") {
      const d = await body(req);
      const correct = barriers.has(key(d.run, d.key)) && d.answer === barriers.get(key(d.run, d.key));
      record({ kind: "answer", run: d.run, key: d.key, correct });
      await sleep(faults.get(key(d.run, "answer"))?.delayMs);
      return send(res, 200, { correct });
    }
    if (p === "/api/click" && req.method === "POST") {
      const d = await body(req);
      record({ kind: "click", run: d.run, target: d.target });
      return send(res, 200, { ok: true });
    }
    if (p === "/api/risky" && req.method === "POST") {
      const d = await body(req);
      record({ kind: "risky", run: d.run, amount: d.amount, requestId: d.requestId });
      const mode = faults.get(key(d.run, "risky"))?.mode;
      if (mode === "drop-after-record") return req.socket.destroy();
      if (mode === "hang") return;
      return send(res, 200, { ok: true });
    }
    // ---- a01a03a07a10 routes ----
    // A navigation that is a ledgered write with a held response: receipt is
    // recorded immediately, the document arrives after `ms` (max 30 s). Lets a
    // write be in flight (intent committed, not confirmed) across a Runtime crash.
    if (p === "/a10/slow-write" && site === "a") {
      record({ kind: "slow-write", run, key: u.searchParams.get("key") });
      await sleep(u.searchParams.get("ms"));
      return html(res, "SLOW WRITE DONE");
    }
    // ---- end a01a03a07a10 routes ----
    if (site !== "a") return send(res, 404, { error: "not found" });
    // ---- a02a04 routes ----
    // Per-tag (per-iteration) login/challenge so earlier iterations' cookies never satisfy later ones.
    // /login-strict rejects any password other than "correct-horse"; ledger entries prove dispatch and continuation.
    {
      const m = /^\/(protected-strict|login-strict|captcha-protected|challenge-strict|a02a04-after|a02a04-tick|a02a04-storage-setup|a02a04-storage-check)\/([a-z0-9-]{1,40})$/.exec(p);
      if (m) {
        const [, route, tag] = m, jar = cookie(req), q = `run=${encodeURIComponent(run)}`;
        const loggedIn = jar[`abp_s_${tag}`] !== undefined && sessions.get(jar[`abp_s_${tag}`]) === `strict:${tag}`;
        const passed = jar[`abp_c_${tag}`] === "ok";
        if (route === "protected-strict") return loggedIn ? html(res, `<title>ABP strict protected ${esc(tag)}</title>STRICT AUTHENTICATED ${esc(tag)}`) : redirect(res, `/login-strict/${tag}?${q}`);
        if (route === "login-strict" && req.method === "POST") {
          const d = await body(req), ok = d.password === "correct-horse";
          record({ kind: "a02a04-login", run: d.run || run, tag, ok });
          if (!ok) return redirect(res, `/login-strict/${tag}?${q}&error=1`);
          const sid = randomUUID();
          sessions.set(sid, `strict:${tag}`);
          res.setHeader("set-cookie", `abp_s_${tag}=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`);
          return redirect(res, `/protected-strict/${tag}?${q}`);
        }
        if (route === "login-strict") return html(res, `<title>ABP strict login ${esc(tag)}</title>${u.searchParams.get("error") ? "<p>WRONG PASSWORD</p>" : ""}<form method="post" action="/login-strict/${esc(tag)}?${esc(q)}"><input type="hidden" name="run" value="${esc(run)}"><label>User <input name="user" autofocus></label><label>Password <input type="password" name="password"></label><button>Log in</button></form>`);
        if (route === "captcha-protected") return passed ? html(res, `<title>ABP captcha passed ${esc(tag)}</title>CAPTCHA PASSED ${esc(tag)}`) : redirect(res, `/challenge-strict/${tag}?${q}`);
        if (route === "challenge-strict" && req.method === "POST") {
          const d = await body(req);
          record({ kind: "a02a04-challenge", run: d.run || run, tag, ok: d.robot === "no" });
          if (d.robot !== "no") return redirect(res, `/challenge-strict/${tag}?${q}`);
          res.setHeader("set-cookie", `abp_c_${tag}=ok; HttpOnly; Path=/; SameSite=Lax`);
          return redirect(res, `/captcha-protected/${tag}?${q}`);
        }
        if (route === "challenge-strict") return html(res, `<title>ABP challenge ${esc(tag)}</title><form method="post" action="/challenge-strict/${esc(tag)}?${esc(q)}"><input type="hidden" name="run" value="${esc(run)}"><label><input type="checkbox" name="robot" value="no" autofocus>I am not a robot</label><button>Continue</button></form>`);
        // Persistent (Max-Age) strict cookie + per-tag localStorage/IndexedDB canaries. The shared /login cookie is a
        // session cookie (dropped on every Chromium restart) and /storage-check has a script syntax error.
        if (route === "a02a04-storage-setup") {
          if (!loggedIn) return redirect(res, `/login-strict/${tag}?${q}`);
          return html(res, `<title>ABP storage setup ${esc(tag)}</title><script>(async()=>{localStorage.setItem('abp_ls_${tag}','ls-${tag}');const r=indexedDB.open('abp_${tag}',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');r.onsuccess=()=>{const t=r.result.transaction('kv','readwrite');t.objectStore('kv').put('idb-${tag}','canary');t.oncomplete=()=>document.body.textContent='STORAGE SET'}})()<\/script>`);
        }
        if (route === "a02a04-storage-check") return html(res, `<title>ABP storage check ${esc(tag)}</title><script>const c=${loggedIn}?'yes':'no';const ls=localStorage.getItem('abp_ls_${tag}')||'none';const out=(v)=>document.body.textContent='COOKIE='+c+' LS='+ls+' IDB='+v;const r=indexedDB.open('abp_${tag}');r.onsuccess=()=>{if(!r.result.objectStoreNames.contains('kv'))return out('none');const g=r.result.transaction('kv').objectStore('kv').get('canary');g.onsuccess=()=>out(g.result||'none');g.onerror=()=>out('none')};r.onerror=()=>out('none')<\/script>`);
        if (route === "a02a04-after") {
          record({ kind: "a02a04-after", run, tag, loggedIn, passed });
          return html(res, `<title>ABP after ${esc(tag)}</title>AFTER ${esc(tag)} login=${loggedIn} captcha=${passed}`);
        }
        // Recorded on arrival (= dispatch), then held for ?ms so a batch spans real time.
        record({ kind: "a02a04-tick", run, tag, n: Number(u.searchParams.get("n") || 0) });
        await sleep(u.searchParams.get("ms"));
        return html(res, `<title>ABP tick ${esc(tag)}</title>TICK ${esc(tag)} ${esc(u.searchParams.get("n"))}`);
      }
    }
    // ---- end a02a04 routes ----
    // ---- a05a06a08a09a11 routes ----
    // Site A pages for the A05/A06/A08/A09/A11 suites. Clicks go to /api/click (ledger kind "click", target = label).
    if (p.startsWith("/x5/")) {
      const post = (target) => `fetch('/api/click',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({run:${esc(script(run))},target:${esc(script(target))}})})`;
      const postJs = (target) => `fetch('/api/click',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({run:${script(run)},target:${script(target)}})})`;
      const onBarrier = (k, js) => k ? `<script>const t=setInterval(async()=>{const s=await(await fetch('/api/barrier-state?run='+encodeURIComponent(${script(run)})+'&key='+encodeURIComponent(${script(k)}))).json();if(s.released){clearInterval(t);${js}}},200)<\/script>` : "";
      const label = String(u.searchParams.get("label") || "panel");
      if (p === "/x5/panel") return html(res, `<style>body{margin:0;height:100vh;background:#${esc(String(u.searchParams.get("color") || "fff").replace(/[^0-9a-fA-F]/g, "").slice(0, 6))}}</style><h1>${esc(label)}</h1><div id="gate">GATE CLOSED</div><button onclick="${post(label)}">Press ${esc(label)}</button>${onBarrier(u.searchParams.get("key"), "document.querySelector('#gate').textContent='GATE OPEN'")}`);
      if (p === "/x5/controls") {
        const n = Math.min(Number(u.searchParams.get("n")) || 30, 400);
        const items = Array.from({ length: n }, (_, i) => `<button type="button" onclick="${post(`item-${i + 1}`)}">Item ${i + 1}</button>`).join("");
        return html(res, `<button disabled onclick="${post("disabled")}">Disabled action</button><button style="visibility:hidden" onclick="${post("hidden")}">Hidden action</button><form aria-label="Items" onsubmit="return false">${items}</form>`);
      }
      if (p === "/x5/frame-reattach") return html(res, `<iframe id="fb" title="Site B" src="${esc(originB)}/frame-b?run=${encodeURIComponent(run)}"></iframe>${onBarrier(u.searchParams.get("key"), `const o=document.querySelector('#fb');const f=document.createElement('iframe');f.id='fb';f.title='Site B';f.src=o.src;o.remove();document.body.append(f);document.body.append(Object.assign(document.createElement('p'),{textContent:'REATTACHED'}));f.onload=()=>${postJs("frame-reattached")}`)}`);
      if (p === "/x5/risky-mutating") {
        const mode = u.searchParams.get("mode") || "none";
        const change = mode === "reload" ? "location.reload()" : mode === "origin" ? `location.href=${script(`${originB}/frame-b?run=${encodeURIComponent(run)}`)}` : mode === "value" ? "document.querySelector('[name=amount]').value='999';document.body.append('VALUE CHANGED')" : mode === "node" ? "const o=document.querySelector('#pay');const b=o.cloneNode(true);o.replaceWith(b);document.body.append('NODE CHANGED')" : "";
        return html(res, `<form id="f"><label>Amount <input name="amount" value="10"></label><button id="pay">Confirm payment</button></form><script>document.querySelector('#f').onsubmit=e=>{e.preventDefault();fetch('/api/risky',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({run:${script(run)},amount:document.querySelector('[name=amount]').value})}).then(r=>r.ok&&document.body.append(' PAYMENT SENT'))}<\/script>${onBarrier(u.searchParams.get("key"), change)}`);
      }
      if (p === "/x5/spa") {
        // Deterministic SPA swap: mode=swap replaces the button when the barrier is released; mode=hover arms the
        // swap on release and performs it on the next pointer move (i.e. during the click's hover).
        const swap = `const d=document.createElement('button');d.textContent='Decoy';d.style.cssText='width:120px;height:40px';d.onclick=()=>${postJs("decoy")};document.querySelector('#target').replaceWith(d)`;
        const onRelease = u.searchParams.get("mode") === "hover" ? `addEventListener('pointermove',()=>{${swap}},{once:true});document.body.append('ARMED');${postJs("spa-armed")}` : `${swap};document.body.append('SWAPPED');${postJs("spa-swapped")}`;
        return html(res, `<button id="target" style="width:120px;height:40px" onclick="${post("target")}">Target</button>${onBarrier(u.searchParams.get("key"), onRelease)}`);
      }
      return send(res, 404, { error: "not found" });
    }
    // ---- end a05a06a08a09a11 routes ----
    if (p === "/login" && req.method === "POST") {
      const d = await body(req), sid = randomUUID();
      sessions.set(sid, String(d.user || "user"));
      res.setHeader("set-cookie", `abp_session=${sid}; HttpOnly; Path=/; SameSite=Lax`);
      return redirect(res, nextPath(d.next || "/protected"));
    }
    if (p === "/login") return html(res, `<form method="post"><input type="hidden" name="next" value="${esc(u.searchParams.get("next") || "/protected")}"><label>User <input name="user"></label><label>Password <input type="password" name="password"></label><button>Log in</button></form>`);
    if (p === "/protected" || p === "/storage-setup") {
      const user = sessions.get(cookie(req).abp_session);
      if (!user) return redirect(res, `/login?next=${encodeURIComponent(p)}`);
      if (p === "/protected") return html(res, `AUTHENTICATED as ${esc(user)}`);
      return html(res, `<script>(async()=>{localStorage.setItem('abp_ls','canary');const r=indexedDB.open('abp',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');r.onsuccess=()=>{const t=r.result.transaction('kv','readwrite');t.objectStore('kv').put('canary','canary');t.oncomplete=()=>document.body.textContent='STORAGE SET'}})()<\/script>`);
    }
    if (p === "/storage-check") return html(res, `<script>const c=${sessions.has(cookie(req).abp_session)}?'yes':'no';const ls=localStorage.getItem('abp_ls')||'none';const r=indexedDB.open('abp');r.onsuccess=()=>{if(!r.result.objectStoreNames.contains('kv'))return document.body.textContent='COOKIE='+c+' LS='+ls+' IDB=none';const g=r.result.transaction('kv').objectStore('kv').get('canary');g.onsuccess=()=>document.body.textContent='COOKIE='+c+' LS='+ls+' IDB='+(g.result||'none')};r.onerror=()=>document.body.textContent='COOKIE='+c+' LS='+ls+' IDB=none'<\/script>`);
    if (p === "/barrier") return html(res, `<div id="state">WAITING</div><script>const run=${script(run)},key=${script(u.searchParams.get("key"))};const timer=setInterval(async()=>{const s=await(await fetch('/api/barrier-state?run='+encodeURIComponent(run)+'&key='+encodeURIComponent(key))).json();if(s.released){clearInterval(timer);document.querySelector('#state').textContent='NONCE: '+s.nonce;const l=document.createElement('label');l.textContent='Answer ';const i=document.createElement('input');l.append(i);const b=document.createElement('button');b.textContent='Submit answer';b.onclick=()=>fetch('/api/answer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({run,key,answer:i.value})});document.body.append(l,b)}},500)<\/script>`);
    if (p === "/oopif") return html(res, `<button onclick="fetch('/api/click',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({run:${esc(script(run))},target:'A-main'})})">Buy</button><div id="shadow"></div><iframe title="Site B" src="${esc(originB)}/frame-b?run=${encodeURIComponent(run)}"></iframe><script>const root=document.querySelector('#shadow').attachShadow({mode:'open'});const b=document.createElement('button');b.textContent='Buy';b.onclick=()=>fetch('/api/click',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({run:${script(run)},target:'A-shadow'})});root.append(b)<\/script>`);
    if (p === "/spa") return html(res, `<button id="target" style="width:120px;height:40px" onclick="fetch('/api/click',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({run:${esc(script(run))},target:'target'})})">Target</button><script>let done=false;function swap(){if(done)return;done=true;const d=document.createElement('button');d.textContent='Decoy';d.style.cssText='width:120px;height:40px';d.onclick=()=>fetch('/api/click',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({run:${script(run)},target:'decoy'})});document.querySelector('#target').replaceWith(d)}addEventListener('pointermove',swap,{once:true});${u.searchParams.has("swapAfterMs") ? `setTimeout(swap,${Math.min(Number(u.searchParams.get("swapAfterMs")) || 0, 3e4)})` : ""}${u.searchParams.get("swap") === "now" ? "setTimeout(swap,100)" : ""}<\/script>`);
    if (p === "/risky-submit") return html(res, `<form id="f"><label>Amount <input name="amount"></label><button>Confirm payment</button></form><script>document.querySelector('#f').onsubmit=e=>{e.preventDefault();fetch('/api/risky',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({run:${script(run)},amount:e.target.amount.value})}).then(r=>r.json()).then(()=>{const m=document.createElement('p');m.id='result';m.textContent='PAYMENT RECORDED';document.body.appendChild(m)})}<\/script>`);
    if (p === "/challenge" && req.method === "POST") {
      res.setHeader("set-cookie", "abp_challenge=ok; HttpOnly; Path=/; SameSite=Lax");
      return redirect(res, nextPath((await body(req)).next || "/challenge-protected"));
    }
    if (p === "/challenge") return html(res, `<form method="post"><input type="hidden" name="next" value="${esc(u.searchParams.get("next") || "/challenge-protected")}"><label><input type="checkbox" required>I am not a robot</label><button>Continue</button></form>`);
    if (p === "/challenge-protected") return cookie(req).abp_challenge === "ok" ? html(res, "CHALLENGE PASSED") : redirect(res, "/challenge?next=/challenge-protected");
    if (p === "/canary-frame") return html(res, `<iframe title="Canary frame" src="${esc(originC)}/secret?run=${encodeURIComponent(run)}"></iframe>`);
    if (p === "/secret-form") return html(res, `<form><label>Password <input type="password" value="ABP-CANARY-PW-${esc(run)}"></label></form>`);
    if (p === "/slow") {
      await sleep(u.searchParams.get("ms"));
      return html(res, "SLOW DONE");
    }
    if (p === "/beforeunload") return html(res, `<button onclick="onbeforeunload=()=>true">Arm</button>`);
    if (p === "/redirect") return redirect(res, u.searchParams.get("to") || "/");
    if (p === "/popup") return html(res, `<button onclick="window.open('${esc(originC)}/secret?run=${encodeURIComponent(run)}')">Open popup</button>`);
    send(res, 404, { error: "not found" });
  } catch {
    if (!res.headersSent) send(res, 400, { error: "bad request" });
  }
}).listen(pagePort, "0.0.0.0");
