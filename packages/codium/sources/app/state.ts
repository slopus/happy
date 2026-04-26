import { atom } from 'jotai'

export const sidebarOpenAtom = atom(true)

const SIDEBAR_WIDTH_KEY = 'codium:sidebar-width'
const SIDEBAR_WIDTH_DEFAULT = 319
const SIDEBAR_WIDTH_MIN = 220
const SIDEBAR_WIDTH_MAX = 480

const readSidebarWidth = () => {
    if (typeof window === 'undefined') return SIDEBAR_WIDTH_DEFAULT
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY)
    const n = raw ? Number(raw) : NaN
    if (!Number.isFinite(n)) return SIDEBAR_WIDTH_DEFAULT
    return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, n))
}

const sidebarWidthBaseAtom = atom(readSidebarWidth())

export const sidebarWidthAtom = atom(
    (get) => get(sidebarWidthBaseAtom),
    (_, set, next: number) => {
        const clamped = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, next))
        set(sidebarWidthBaseAtom, clamped)
        if (typeof window !== 'undefined') {
            window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped))
        }
    }
)

export const SIDEBAR_WIDTH_BOUNDS = {
    min: SIDEBAR_WIDTH_MIN,
    max: SIDEBAR_WIDTH_MAX,
}
export const preSettingsPathAtom = atom<string>('/chat/new')
export const searchOpenAtom = atom(false)

export interface TerminalEntry {
    id: string
    title: string
}

export const terminalsAtom = atom<TerminalEntry[]>([])

export const fullscreenAtom = atom<boolean>(
    typeof window !== 'undefined' && window.win
        ? window.win.isFullScreenSync()
        : false
)

export type EffortLevel = 'low' | 'medium' | 'high'

export const modelAtom = atom<string>('gpt-5-5')
export const effortAtom = atom<EffortLevel>('high')
export const contextUsageAtom = atom<number>(0.24)
