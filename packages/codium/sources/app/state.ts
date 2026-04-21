import { atom } from 'jotai'

export const sidebarOpenAtom = atom(true)
export const preSettingsPathAtom = atom<string>('/chat/new')
export const searchOpenAtom = atom(false)

export interface TerminalEntry {
    id: string
    title: string
}

export const terminalsAtom = atom<TerminalEntry[]>([])
