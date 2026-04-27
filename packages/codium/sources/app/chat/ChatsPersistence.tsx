import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'
import {
    chatOrderAtom,
    chatsAtom,
    hydrateChatsAtom,
    type Chat,
} from './store'

/**
 * Mount-once side-effect component that:
 *   - loads persisted chats from <userData>/codium-chats.json on boot
 *   - subscribes to chat changes and writes them back, debounced
 *
 * Renders nothing. Sits at the root of the app tree.
 */
export function ChatsPersistence() {
    const chats = useAtomValue(chatsAtom)
    const order = useAtomValue(chatOrderAtom)
    const hydrate = useSetAtom(hydrateChatsAtom)
    const hydratedRef = useRef(false)
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // Load once on first mount.
    useEffect(() => {
        let cancelled = false
        void window.chats.load().then((snap) => {
            if (cancelled) return
            hydrate({
                chats: snap.chats as Record<string, Chat>,
                order: snap.order,
            })
            // Set the gate AFTER hydration so the save effect below doesn't
            // immediately overwrite the file with the empty pre-load state.
            hydratedRef.current = true
        })
        return () => {
            cancelled = true
        }
    }, [hydrate])

    // Debounced save on every change.
    useEffect(() => {
        if (!hydratedRef.current) return
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => {
            void window.chats.save({ chats, order })
        }, 250)
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current)
        }
    }, [chats, order])

    return null
}
