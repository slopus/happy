/** S5 spike: window-per-task churn memory trend (Chromium process RSS/PSS sum). tsx churn.ts <container> <port> <cycles> <sampleEvery> */
import { execFileSync } from 'node:child_process'
import { CdpConnection } from '../../../../src/browserRuntime/drivers/cdpConnection'

const [container, port, cyclesArg, everyArg] = process.argv.slice(2)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function mem() {
    const script = `t=0; p=0; n=0; for d in /proc/[0-9]*; do c=$(tr '\\0' ' ' < $d/cmdline 2>/dev/null); case "$c" in *chromium*) r=$(awk '/^Rss:/{print $2}' $d/smaps_rollup 2>/dev/null); s=$(awk '/^Pss:/{print $2}' $d/smaps_rollup 2>/dev/null); t=$((t+\${r:-0})); p=$((p+\${s:-0})); n=$((n+1));; esac; done; echo $t $p $n`
    const [rss, pss, n] = execFileSync('docker', ['exec', container, 'sh', '-c', script]).toString().trim().split(' ').map(Number)
    return `rss=${(rss / 1024).toFixed(0)} pss=${(pss / 1024).toFixed(0)} procs=${n}`
}
async function main() {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as any
    const conn = await CdpConnection.connect(version.webSocketDebuggerUrl)
    await conn.send('Target.setDiscoverTargets', { discover: true })
    await sleep(2000)
    console.log('cycle 0', mem())
    const concurrent = 2
    for (let i = 1; i <= Number(cyclesArg); i++) {
        await Promise.all(Array.from({ length: concurrent }, async (_v, k) => {
            const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank', background: true, newWindow: true })
            const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true })
            await conn.send('Page.enable', {}, sessionId)
            await conn.send('Page.navigate', { url: `data:text/html,<body style="background:rgb(${i % 255},${k * 100},9)"><input><button>b${i}</button>${'x'.repeat(2000)}</body>` }, sessionId)
            await sleep(150)
            await conn.send('Page.captureScreenshot', { format: 'png' }, sessionId)
            const gone = new Promise<void>((resolve) => { const off = conn.on('Target.targetDestroyed', (p) => { if (p.targetId === targetId) { off(); resolve() } }) })
            await conn.send('Page.close', {}, sessionId)
            await gone
        }))
        if (i % Number(everyArg) === 0) { await sleep(1500); console.log('cycle', i, mem()) }
    }
    conn.close()
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
