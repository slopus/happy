/**
 * S5 spike: anchor-window placement of task tabs in the pinned headful Chromium.
 * Usage: tsx spike.ts <container> <hostPort> [cycles]
 */
import { execFileSync } from 'node:child_process'
import { CdpConnection } from '../../../../src/browserRuntime/drivers/cdpConnection'
import { decodePng } from '../../../../src/browserRuntime/drivers/pocTestKit'

const [container, port, cyclesArg] = process.argv.slice(2)
const cycles = Number(cyclesArg ?? 60)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function mem(): { rssMiB: number; pssMiB: number; procs: number } {
    const script = `t=0; p=0; n=0; for d in /proc/[0-9]*; do c=$(tr '\\0' ' ' < $d/cmdline 2>/dev/null); case "$c" in *chromium*) r=$(awk '/^Rss:/{print $2}' $d/smaps_rollup 2>/dev/null); s=$(awk '/^Pss:/{print $2}' $d/smaps_rollup 2>/dev/null); t=$((t+\${r:-0})); p=$((p+\${s:-0})); n=$((n+1));; esac; done; echo $t $p $n`
    const [rss, pss, n] = execFileSync('docker', ['exec', container, 'sh', '-c', script]).toString().trim().split(' ').map(Number)
    return { rssMiB: Math.round(rss / 102.4) / 10, pssMiB: Math.round(pss / 102.4) / 10, procs: n }
}
function activeWindow(): string {
    try {
        const id = execFileSync('docker', ['exec', '-e', 'DISPLAY=:99', container, 'xdotool', 'getactivewindow']).toString().trim()
        return id
    } catch { return 'none' }
}

async function main() {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as any
    const conn = await CdpConnection.connect(version.webSocketDebuggerUrl)
    const created: any[] = []
    conn.on('Target.targetCreated', (p) => created.push(p.targetInfo))
    await conn.send('Target.setDiscoverTargets', { discover: true })
    await sleep(1500)
    const { targetInfos } = await conn.send('Target.getTargets', {})
    const user = targetInfos.find((t: any) => t.type === 'page')
    const userSession = (await conn.send('Target.attachToTarget', { targetId: user.targetId, flatten: true })).sessionId
    await conn.send('Page.navigate', { url: 'data:text/html,<title>user</title><body style="background:rgb(200,20,20)">user</body>' }, userSession)
    await sleep(500)
    const userWindow = (await conn.send('Browser.getWindowForTarget', { targetId: user.targetId })).windowId
    const activeBefore = activeWindow()
    console.log('version', version.Browser, 'userWindow', userWindow, 'activeX', activeBefore)
    console.log('targets at start', targetInfos.map((t: any) => `${t.type}:${t.url}`).join(' | '))
    await sleep(2000)
    const m0 = mem()
    console.log('mem baseline', m0, 'user focus at start', (await conn.send('Runtime.evaluate', { expression: `document.visibilityState + '/' + document.hasFocus()`, returnByValue: true }, userSession)).result.value)

    // --- 4 anchor windows
    const anchors: Array<{ targetId: string; sessionId: string; windowId: number }> = []
    for (let i = 0; i < 4; i++) {
        const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank', background: true, newWindow: true })
        const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true })
        await conn.send('Page.enable', {}, sessionId)
        const { windowId } = await conn.send('Browser.getWindowForTarget', { targetId })
        anchors.push({ targetId, sessionId, windowId })
    }
    await sleep(3000)
    const m1 = mem()
    console.log('mem after 4 anchor windows', m1, 'per window MiB rss', ((m1.rssMiB - m0.rssMiB) / 4).toFixed(1), 'pss', ((m1.pssMiB - m0.pssMiB) / 4).toFixed(1))
    const all = (await conn.send('Target.getTargets', {})).targetInfos
    console.log('target types after anchors', JSON.stringify(all.reduce((acc: any, t: any) => { const k = `${t.type}:${t.url.replace(/\?.*/, '')}`; acc[k] = (acc[k] ?? 0) + 1; return acc }, {})))
    console.log('activeX after anchors', activeWindow(), 'same as before', activeWindow() === activeBefore)

    // --- placement: window.open from anchor 0
    const openTask = async (anchor: typeof anchors[number], color: string) => {
        const before = created.length
        const res = await conn.send('Runtime.evaluate', { expression: `window.open('about:blank','_blank','noopener') === null`, userGesture: true, returnByValue: true }, anchor.sessionId)
        let info: any
        for (let i = 0; i < 50 && !info; i++) {
            info = created.slice(before).find((t: any) => t.type === 'page' && t.targetId !== anchor.targetId)
            if (!info) await sleep(20)
        }
        if (!info) throw new Error('no targetCreated')
        const { sessionId } = await conn.send('Target.attachToTarget', { targetId: info.targetId, flatten: true })
        await conn.send('Page.enable', {}, sessionId)
        const { windowId } = await conn.send('Browser.getWindowForTarget', { targetId: info.targetId })
        await conn.send('Page.navigate', { url: `data:text/html,<body style="margin:0;background:${color}">task</body>` }, sessionId)
        await sleep(200)
        return { info, sessionId, windowId, returnedNull: res.result.value }
    }
    const task = await openTask(anchors[0], 'rgb(10,200,30)')
    console.log('task info', JSON.stringify({ openerId: task.info.openerId, openerFrameId: task.info.openerFrameId, canAccessOpener: task.info.canAccessOpener, url: task.info.url }), 'windowOpen returned null', task.returnedNull)
    console.log('task in anchor window', task.windowId === anchors[0].windowId)
    const vis = async (sessionId: string) => (await conn.send('Runtime.evaluate', { expression: `document.visibilityState + '/' + document.hasFocus()`, returnByValue: true }, sessionId)).result.value
    console.log('visibility task', await vis(task.sessionId), 'anchor', await vis(anchors[0].sessionId), 'user', await vis(userSession))
    console.log('activeX after open', activeWindow(), 'unchanged', activeWindow() === activeBefore)
    const shot = await conn.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, task.sessionId)
    const png = decodePng(shot.data)
    const px = (x: number, y: number) => png.pixel(x, y)
    console.log('screenshot size', png.width, png.height, 'center pixel', px(Math.floor(png.width / 2), Math.floor(png.height / 2)))
    // user window screenshot still own colour (not affected)
    const ushot = decodePng((await conn.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, userSession)).data)
    console.log('user center pixel', ushot.pixel(Math.floor(ushot.width / 2), Math.floor(ushot.height / 2)))
    // second task in another anchor, capture both
    const task2 = await openTask(anchors[1], 'rgb(20,30,220)')
    const s2 = decodePng((await conn.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, task2.sessionId)).data)
    const s1b = decodePng((await conn.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, task.sessionId)).data)
    const c = (p: any) => p.pixel(Math.floor(p.width / 2), Math.floor(p.height / 2))
    console.log('two tasks capture', c(s1b), c(s2), 'activeX unchanged', activeWindow() === activeBefore)

    // beforeunload on task, Page.close keeps anchor
    await conn.send('Runtime.evaluate', { expression: `addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = '' }); 1`, userGesture: true }, task2.sessionId)
    // user activation needed for beforeunload: simulate a click
    await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10, button: 'left', clickCount: 1 }, task2.sessionId)
    await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 10, button: 'left', clickCount: 1 }, task2.sessionId)
    const dialog = new Promise<any>((resolve) => { const off = conn.on('Page.javascriptDialogOpening', (p, sid) => { if (sid === task2.sessionId) { off(); resolve(p) } }); setTimeout(() => resolve(null), 3000) })
    await conn.send('Page.close', {}, task2.sessionId)
    const d = await dialog
    console.log('beforeunload dialog', d?.type ?? 'none')
    if (d) await conn.send('Page.handleJavaScriptDialog', { accept: false }, task2.sessionId)
    await sleep(300)
    const stillThere = (await conn.send('Target.getTargets', {})).targetInfos.some((t: any) => t.targetId === task2.info.targetId)
    console.log('task2 still open after dismissed beforeunload', stillThere)

    // close task 1 via Page.close (no beforeunload)
    const destroyed = new Promise<boolean>((resolve) => { const off = conn.on('Target.targetDestroyed', (p) => { if (p.targetId === task.info.targetId) { off(); resolve(true) } }); setTimeout(() => resolve(false), 3000) })
    await conn.send('Page.close', {}, task.sessionId)
    console.log('task1 destroyed', await destroyed)
    const anchorWin = await conn.send('Browser.getWindowForTarget', { targetId: anchors[0].targetId }).then((r: any) => r.windowId).catch(() => 'gone')
    console.log('anchor window after close', anchorWin, 'same', anchorWin === anchors[0].windowId, 'anchor visibility', await vis(anchors[0].sessionId))
    console.log('activeX after close', activeWindow() === activeBefore)

    // anchor loss: close anchor 3's target while it holds no task -> window should go away
    await conn.send('Target.closeTarget', { targetId: anchors[3].targetId })
    await sleep(500)
    const windowsLeft = await conn.send('Browser.getWindowForTarget', { targetId: anchors[3].targetId }).then(() => 'still').catch(() => 'gone')
    console.log('anchor3 window after anchor close', windowsLeft)

    // what if the anchor is closed while a task tab is in its window?
    const t3 = await openTask(anchors[2], 'rgb(5,5,5)')
    await conn.send('Target.closeTarget', { targetId: anchors[2].targetId })
    await sleep(500)
    const t3win = await conn.send('Browser.getWindowForTarget', { targetId: t3.info.targetId }).then((r: any) => r.windowId).catch(() => 'gone')
    console.log('task tab survives anchor close, window', t3win, 'same', t3win === anchors[2].windowId)
    await conn.send('Target.closeTarget', { targetId: t3.info.targetId })
    await conn.send('Page.handleJavaScriptDialog', { accept: true }, task2.sessionId).catch(() => undefined)
    await conn.send('Target.closeTarget', { targetId: task2.info.targetId })
    await sleep(1000)

    // --- churn: pool (2 anchors: 0 and 1) vs window-per-tab
    const pool = [anchors[0], anchors[1]]
    await sleep(2000)
    const mp0 = mem()
    for (let i = 0; i < cycles; i++) {
        const t = await openTask(pool[i % 2], 'rgb(1,2,3)')
        await conn.send('Page.captureScreenshot', { format: 'png' }, t.sessionId)
        const gone = new Promise<void>((resolve) => { const off = conn.on('Target.targetDestroyed', (p) => { if (p.targetId === t.info.targetId) { off(); resolve() } }) })
        await conn.send('Page.close', {}, t.sessionId)
        await gone
    }
    await sleep(3000)
    const mp1 = mem()
    console.log(`pool churn ${cycles}: before`, mp0, 'after', mp1, 'delta rss', (mp1.rssMiB - mp0.rssMiB).toFixed(1))
    for (let i = 0; i < cycles; i++) {
        const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank', background: true, newWindow: true })
        const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true })
        await conn.send('Page.enable', {}, sessionId)
        await conn.send('Page.navigate', { url: 'data:text/html,<body>x</body>' }, sessionId)
        await sleep(200)
        await conn.send('Page.captureScreenshot', { format: 'png' }, sessionId)
        const gone = new Promise<void>((resolve) => { const off = conn.on('Target.targetDestroyed', (p) => { if (p.targetId === targetId) { off(); resolve() } }) })
        await conn.send('Page.close', {}, sessionId)
        await gone
    }
    await sleep(3000)
    const mw1 = mem()
    console.log(`window-per-tab churn ${cycles}: after`, mw1, 'delta rss vs pool end', (mw1.rssMiB - mp1.rssMiB).toFixed(1))
    conn.close()
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
