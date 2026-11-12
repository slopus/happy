// The metrics listener (API port + 6000 here): /metrics compared as data
// (families, help, type, label sets, counter and gauge values; histogram bounds
// and counts, not timings), plus its /health and 404.
import { Raw, connected, login } from './phase2.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Prometheus text exposition → { family: { help, type, series: { 'name{sorted labels}': value } } }. */
function parse(text) {
    const fams = {};
    const fam = (n) => (fams[n] ??= { help: null, type: null, series: {} });
    for (const line of text.split('\n')) {
        let m;
        if ((m = line.match(/^# HELP (\S+) (.*)$/))) fam(m[1]).help = m[2];
        else if ((m = line.match(/^# TYPE (\S+) (\S+)$/))) fam(m[1]).type = m[2];
        else if ((m = line.match(/^([a-zA-Z_:][\w:]*)(?:\{(.*)\})? (\S+)$/))) {
            const labels = [...(m[2] || '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((x) => `${x[1]}=${x[2]}`).sort().join(',');
            const base = m[1].replace(/_(bucket|sum|count)$/, '');
            const f = fams[m[1]] ? m[1] : base;
            fam(f).series[`${m[1]}{${labels}}`] = Number(m[3]);
        }
    }
    return fams;
}

function comparable(fams) {
    const out = {};
    for (const [name, f] of Object.entries(fams).sort()) {
        if (name.startsWith('prisma_')) continue; // QUIRKS deviation 3
        if (name === 'log_lines_dropped_total') continue; // Rust only (non-blocking log writer)
        if (name === 'message_write_batch_size') continue; // Rust only (group commit)
        if (name.startsWith('history_')) continue; // Rust only (history offload)
        const series = {};
        for (const [k, v] of Object.entries(f.series).sort()) {
            if (k.includes('_sum{') || k.includes('_bucket{')) continue; // timings; _count stays
            if (name === 'database_records_total') series[k] = 'n'; // planner estimates
            else if (k.includes('route=/,')) series[k] = 'n'; // readiness polls while the server starts
            else series[k] = v;
        }
        out[name] = { help: f.help, type: f.type, series };
    }
    return out;
}

export async function scenario(t) {
    const base = t.base;
    const mbase = base.replace(/:(\d+)$/, (_, p) => ':' + (Number(p) + 6000));
    const token = await login(t, 1);
    const H = { authorization: 'Bearer ' + token, 'x-happy-client': 'happy-ios/1.2.3' };
    await t.req('sessions', 'GET', '/v1/sessions', { headers: H });
    await t.req('not found', 'GET', '/v1/nope');
    await t.req('validation', 'POST', '/v1/sessions', { headers: H, body: {} });
    const s = await t.req('session', 'POST', '/v1/sessions', { headers: H, body: { tag: 't', metadata: 'm' } });
    const ui = await connected(t, 'ui', { token, clientType: 'user-scoped', happyClient: 'happy-android/2.0' });
    const ss = await connected(t, 'ss', { token, clientType: 'session-scoped', sessionId: s.session.id });
    const daemon = await connected(t, 'daemon', { token, clientType: 'machine-scoped', machineId: 'm1' });
    ss.emit('session-alive', { sid: s.session.id, time: Date.now() });
    daemon.emit('machine-alive', { machineId: 'm1', time: Date.now() });
    ss.emit('message', { sid: s.session.id, message: 'enc' });
    daemon.emit('rpc-register', { method: 'm1:x' });
    await sleep(300);
    ui.emit('rpc-call', { method: 'm1:x', params: {} }, 1);
    ui.emit('rpc-call', { method: 'nobody:x', params: {} }, 2);
    await daemon.until(2);
    const req = daemon.take().find((f) => f.p?.startsWith?.('42') && f.d?.[0] === 'rpc-request');
    if (req) daemon.send('43' + req.p.slice(2) + '[{"ok":1}]');
    await sleep(500);
    ss.close();

    await sleep(6000); // activity flush (5 s) and the metrics are settled
    const res = await fetch(mbase + '/metrics');
    t.note('metrics status', { status: res.status, type: res.headers.get('content-type') });
    t.note('metrics', comparable(parse(await res.text())));
    const h = await fetch(mbase + '/health');
    t.note('metrics /health', { status: h.status, type: h.headers.get('content-type'), keys: Object.keys(await h.json()) });
    const nf = await fetch(mbase + '/nope');
    t.note('metrics 404', { status: nf.status, body: await nf.text() });
    for (const c of [ui, daemon]) c.close();
}
