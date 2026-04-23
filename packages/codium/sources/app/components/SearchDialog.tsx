import * as Dialog from '@radix-ui/react-dialog'
import { Command } from 'cmdk'
import { useAtom } from 'jotai'
import { useEffect } from 'react'
import { searchOpenAtom } from '@/app/state'

export function SearchDialog() {
    const [open, setOpen] = useAtom(searchOpenAtom)

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault()
                setOpen((v) => !v)
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [setOpen])

    return (
        <Dialog.Root open={open} onOpenChange={setOpen}>
            <Dialog.Portal>
                <Dialog.Overlay className="search-dialog__overlay" />
                <Dialog.Content
                    className="search-dialog__content"
                    aria-describedby={undefined}
                >
                    <Dialog.Title className="sr-only">Search</Dialog.Title>
                    <Command className="search-dialog__command" label="Search">
                        <Command.Input
                            className="search-dialog__input"
                            placeholder="Search chats, automations, plugins…"
                            autoFocus
                        />
                        <Command.List className="search-dialog__list">
                            <Command.Empty className="search-dialog__empty">
                                No results.
                            </Command.Empty>
                            <Command.Group heading="Chats" className="search-dialog__group">
                                <Command.Item className="search-dialog__item">
                                    Example chat
                                </Command.Item>
                            </Command.Group>
                            <Command.Group heading="Automations" className="search-dialog__group">
                                <Command.Item className="search-dialog__item">
                                    Example automation
                                </Command.Item>
                            </Command.Group>
                        </Command.List>
                    </Command>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    )
}
