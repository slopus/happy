/** S5 spike: does opening a task tab via an anchor take X input focus from a focused user window? */
import { execFileSync } from 'node:child_process'
import { CdpConnection } from '../../../../src/browserRuntime/drivers/cdpConnection'

const [container, port] = process.argv.slice(2)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const x = (...args: string[]) => { try { return execFileSync('docker', ['exec', '-e', 'DISPLAY=:99', container, 'xdotool', ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return 'err' } }

async function main() {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as any
    const conn = await CdpConnection.connect(version.webSocketDebuggerUrl)
    const created: any[] = []
    conn.on('Target.targetCreated', (p) => created.push(p.targetInfo))
    await conn.send('Target.setDiscoverTargets', { discover: true })
    const user = (await conn.send('Target.getTargets', {})).targetInfos.find((t: any) => t.type === 'page')
    const us = (await conn.send('Target.attachToTarget', { targetId: user.targetId, flatten: true })).sessionId
    await conn.send('Page.navigate', { url: 'data:text/html,<title>userwin</title><input id=i autofocus>' }, us)
    await sleep(800)
    const userX = x('search', '--name', 'userwin').split('\n')[0]
    x('windowfocus', '--sync', userX)
    await sleep(300)
    const focus = async (label: string, extra: Record<string, string> = {}) => {
        const hf = (await conn.send('Runtime.evaluate', { expression: 'document.hasFocus()', returnByValue: true }, us)).result.value
        const extras = Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' ')
        console.log(label, 'xfocus', x('getwindowfocus'), 'userX', userX, 'user.hasFocus', hf, extras)
    }
    await focus('start')
    // typing via X goes where?
    const typeCheck = async (label: string) => {
        x('type', '--delay', '0', 'k')
        await sleep(200)
        const v = (await conn.send('Runtime.evaluate', { expression: 'document.getElementById("i").value', returnByValue: true }, us)).result.value
        console.log(label, 'user input value', JSON.stringify(v))
    }
    await typeCheck('start')

    const mode = process.argv[4] ?? 'anchor'
    if (mode === 'anchor') {
        const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank', background: true, newWindow: true })
        const as = (await conn.send('Target.attachToTarget', { targetId, flatten: true })).sessionId
        await sleep(500)
        await focus('after anchor window')
        await typeCheck('after anchor window')
        for (let i = 0; i < 3; i++) {
            const before = created.length
            await conn.send('Runtime.evaluate', { expression: `window.open('about:blank','_blank','noopener'); 1`, userGesture: true }, as)
            await sleep(500)
            const t = created.slice(before).find((c: any) => c.type === 'page')
            const ts = (await conn.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId
            await conn.send('Page.navigate', { url: 'data:text/html,<input id=j autofocus>' }, ts)
            await sleep(500)
            const tv = async () => (await conn.send('Runtime.evaluate', { expression: 'document.getElementById("j")?.value ?? null', returnByValue: true }, ts)).result.value
            await focus(`after task open ${i}`)
            await typeCheck(`after task open ${i}`)
            console.log('  task input value', JSON.stringify(await tv()))
            await conn.send('Page.close', {}, ts)
            await sleep(400)
            await focus(`after task close ${i}`)
            await typeCheck(`after task close ${i}`)
        }
    } else {
        for (let i = 0; i < 3; i++) {
            const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank', background: true, newWindow: true })
            const ts = (await conn.send('Target.attachToTarget', { targetId, flatten: true })).sessionId
            await conn.send('Page.navigate', { url: 'data:text/html,<input id=j autofocus>' }, ts)
            await sleep(500)
            await focus(`window-per-tab open ${i}`)
            await typeCheck(`window-per-tab open ${i}`)
            await conn.send('Page.close', {}, ts)
            await sleep(400)
        }
    }
    conn.close()
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
