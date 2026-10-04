import { parseAllowlist } from './allowlist.js'
import { parseAutoConnectParams } from './autoConnect.js'
import { attemptNativePairing, attemptSetupPairing } from './nativePairing.js'

const hostInput = document.getElementById('host')
const portInput = document.getElementById('port')
const tokenInput = document.getElementById('token')
const profileInput = document.getElementById('profile')
const allowlistInput = document.getElementById('allowlist')
const status = document.getElementById('status')
const autoPairingStatus = document.getElementById('auto-pairing-status')
const retryAutoPairingButton = document.getElementById('retry-auto-pairing')
const setupOperationId = new URLSearchParams(location.search).get('setup')
if (setupOperationId) history.replaceState(null, '', location.pathname)

const stored = await chrome.storage.local.get(['host', 'port', 'token', 'profile', 'allowlist'])
hostInput.value = stored.host || '127.0.0.1'
portInput.value = stored.port || 41777
tokenInput.value = stored.token || ''
profileInput.value = stored.profile || 'default'
allowlistInput.value = stored.allowlist || ''

async function save({ debuggerTier, pairingId, viewerKey } = {}) {
    const token = tokenInput.value.trim()
    if (!token) {
        status.textContent = '토큰을 입력해 주세요.'
        return
    }
    const allowlist = allowlistInput.value
    // The service worker watches storage and reconnects on change.
    await chrome.storage.local.set({
        host: hostInput.value.trim() || '127.0.0.1',
        port: Number(portInput.value) || 41777,
        token,
        profile: profileInput.value.trim() || 'default',
        // This identifies one automated pairing attempt, not the user's
        // profile. A manual/ordinary save clears a marker left by that run.
        pairingId: pairingId || '',
        // Manual saves return to the legacy/manual bridge boundary.
        viewerKey: viewerKey || '',
        allowlist,
        // Only when the caller was explicit — see parseAutoConnectParams.
        ...(debuggerTier === undefined ? {} : { debuggerTier }),
    })

    // Say plainly which of the two very different modes is now in force —
    // "unrestricted" is the riskier one and should never be a silent default
    // the user didn't realise they were in.
    const patterns = parseAllowlist(allowlist)
    status.textContent = patterns.length === 0
        ? '저장했습니다. allowlist가 비어 있어 모든 사이트를 제어할 수 있습니다.'
        : `저장했습니다. ${patterns.length}개 패턴만 허용됩니다: ${patterns.join(', ')}`
}

document.getElementById('save').addEventListener('click', save)

// `happy browser` prints a chrome-extension://<id>/src/options.html?token=...
// link so first-time setup is "open link" instead of "copy token, switch to
// this tab, paste, save". The token still came from a link the user chose to
// open, so auto-saving it is no riskier than them pasting it themselves.
//
// The same reasoning extends `debugger=1` to the debugger tier: on a headless
// Linux box nobody can press the toggle below, and the link is something the
// user ran `happy browser pair --debugger` to produce. The property cdp.js
// cares about still holds — no protocol command writes extension storage, so
// the agent cannot grant this to itself.
const autoConnect = parseAutoConnectParams(location.search)
if (autoConnect) {
    tokenInput.value = autoConnect.token
    portInput.value = autoConnect.port
    // Only when the link was explicit — otherwise the field keeps the stored
    // value loaded above, and save() below preserves it.
    if (autoConnect.host !== undefined) hostInput.value = autoConnect.host
    // Scrub the token from the visible URL / this navigation's history entry
    // right away — nothing downstream needs it to stay there.
    history.replaceState(null, '', location.pathname)
    await save({
        debuggerTier: autoConnect.debuggerTier,
        pairingId: autoConnect.pairingId,
        viewerKey: autoConnect.viewerKey,
    })
    status.textContent = `링크로 자동 연결되었습니다. ${status.textContent}`
    if (autoConnect.debuggerTier !== undefined) {
        status.textContent += autoConnect.debuggerTier
            ? ' 정밀 제어도 켰습니다.'
            : ' 정밀 제어는 껐습니다.'
    }
}

async function tryNativePairing() {
    retryAutoPairingButton.hidden = true
    autoPairingStatus.textContent = '이 컴퓨터의 Happy 데몬을 확인하고 있습니다…'
    const result = await attemptNativePairing(chrome)

    if (result.status === 'paired') {
        const local = await chrome.storage.local.get(['host', 'port', 'token'])
        hostInput.value = local.host
        portInput.value = local.port
        tokenInput.value = local.token
        autoPairingStatus.textContent = '자동 연결 설정을 저장했습니다. Happy 데몬에 연결을 시도합니다.'
        return
    }
    if (result.status === 'already-configured') {
        autoPairingStatus.textContent = '저장된 연결 설정을 사용하고 있습니다.'
        return
    }

    autoPairingStatus.textContent = result.status === 'unavailable'
        ? '자동 연결 도우미를 찾지 못했습니다. Happy 데몬을 업데이트한 뒤 데몬과 Chrome을 재시작하거나 아래에서 직접 설정하세요.'
        : '자동 연결 응답을 확인하지 못했습니다. 아래에서 직접 설정하거나 다시 시도하세요.'
    retryAutoPairingButton.hidden = false
}

retryAutoPairingButton.addEventListener('click', tryNativePairing)

if (setupOperationId) {
    const result = await attemptSetupPairing(chrome, setupOperationId)
    autoPairingStatus.textContent = result.status === 'paired'
        ? 'Saycode 사용자별 연결을 저장했습니다. Desktop에서 연결 확인을 계속하세요.'
        : 'Saycode 설정을 완료하지 못했습니다. Desktop에서 다시 연결을 시작하세요.'
    retryAutoPairingButton.hidden = true
    tokenInput.value = ''
    tokenInput.disabled = true
    document.getElementById('save').disabled = true
} else if (autoConnect) {
    autoPairingStatus.textContent = '설정 링크의 연결 정보를 사용했습니다.'
} else {
    await tryNativePairing()
}

// The debugger tier is gated by a stored setting, not an optional Chrome
// permission: Chrome does not allow `debugger` in optional_permissions (it is
// on the documented exclusion list), so requesting it at runtime fails with
// "Only permissions specified in the manifest may be requested". See cdp.js
// for the full reasoning. The agent has no command that writes extension
// storage, so it still cannot switch this on for itself.
const debuggerButton = document.getElementById('toggle-debugger')
const debuggerStatus = document.getElementById('debugger-status')
let debuggerEnabled = false

function renderDebuggerState(enabled) {
    debuggerEnabled = enabled
    debuggerButton.textContent = enabled ? '정밀 제어 끄기' : '정밀 제어 켜기'
    debuggerStatus.textContent = enabled
        ? '켜짐 — trusted 입력과 전체 페이지 스크린샷을 쓸 수 있습니다.'
        : '꺼짐 — 나머지 기능은 그대로 동작합니다.'
}

debuggerButton.addEventListener('click', async () => {
    try {
        const next = !debuggerEnabled
        await chrome.storage.local.set({ debuggerTier: next })
        renderDebuggerState(next)
    } catch (e) {
        debuggerStatus.textContent = `오류: ${e.message}`
    }
})

renderDebuggerState((await chrome.storage.local.get(['debuggerTier'])).debuggerTier === true)
