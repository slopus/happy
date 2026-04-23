import { atom } from 'jotai'

export const sidebarOpenAtom = atom(true)
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

export const modelAtom = atom<string>('claude-opus-4-7')
export const effortAtom = atom<EffortLevel>('high')
export const contextUsageAtom = atom<number>(0.24)
