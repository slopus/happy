import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { EditorState, Plugin, type Command } from 'prosemirror-state'
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view'
import { Schema } from 'prosemirror-model'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap } from 'prosemirror-commands'
import { history, undo, redo } from 'prosemirror-history'

const schema = new Schema({
    nodes: {
        doc: { content: 'block+' },
        paragraph: {
            group: 'block',
            content: 'inline*',
            toDOM: () => ['p', 0],
            parseDOM: [{ tag: 'p' }],
        },
        hard_break: {
            inline: true,
            group: 'inline',
            selectable: false,
            parseDOM: [{ tag: 'br' }],
            toDOM: () => ['br'],
        },
        text: { group: 'inline' },
    },
})

function placeholderPlugin(text: string) {
    return new Plugin({
        props: {
            decorations(state) {
                const { doc } = state
                if (
                    doc.childCount === 1 &&
                    doc.firstChild?.type.name === 'paragraph' &&
                    doc.firstChild.content.size === 0
                ) {
                    return DecorationSet.create(doc, [
                        Decoration.node(0, doc.firstChild.nodeSize, {
                            class: 'is-empty',
                            'data-placeholder': text,
                        }),
                    ])
                }
                return null
            },
        },
    })
}

export interface ComposerEditorHandle {
    clear(): void
    focus(): void
}

interface ComposerEditorProps {
    placeholder?: string
    onSubmit?: (text: string) => void
    onUpdate?: (text: string) => void
}

export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(
    function ComposerEditor({ placeholder = '', onSubmit, onUpdate }, ref) {
        const rootRef = useRef<HTMLDivElement>(null)
        const viewRef = useRef<EditorView | null>(null)
        const onSubmitRef = useRef(onSubmit)
        const onUpdateRef = useRef(onUpdate)
        onSubmitRef.current = onSubmit
        onUpdateRef.current = onUpdate

        useImperativeHandle(
            ref,
            () => ({
                clear() {
                    const view = viewRef.current
                    if (!view) return
                    view.dispatch(view.state.tr.delete(0, view.state.doc.content.size))
                },
                focus() {
                    viewRef.current?.focus()
                },
            }),
            []
        )

        useEffect(() => {
            const root = rootRef.current
            if (!root) return

            const hardBreak: Command = (state, dispatch) => {
                if (dispatch) {
                    dispatch(
                        state.tr
                            .replaceSelectionWith(schema.nodes.hard_break.create())
                            .scrollIntoView()
                    )
                }
                return true
            }

            const submit: Command = (state) => {
                const text = state.doc.textContent
                if (!text.trim()) return true
                onSubmitRef.current?.(text)
                return true
            }

            const state = EditorState.create({
                schema,
                plugins: [
                    history(),
                    keymap({
                        'Mod-z': undo,
                        'Mod-y': redo,
                        'Mod-Shift-z': redo,
                        Enter: submit,
                        'Shift-Enter': hardBreak,
                    }),
                    keymap(baseKeymap),
                    placeholderPlugin(placeholder),
                ],
            })

            const view = new EditorView(root, {
                state,
                dispatchTransaction(tr) {
                    const newState = view.state.apply(tr)
                    view.updateState(newState)
                    if (tr.docChanged) {
                        onUpdateRef.current?.(newState.doc.textContent)
                    }
                },
            })
            viewRef.current = view
            return () => {
                view.destroy()
                viewRef.current = null
            }
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [])

        return <div ref={rootRef} className="composer__editor" />
    }
)
