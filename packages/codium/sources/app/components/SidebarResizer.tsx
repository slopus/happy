import { useAtom } from 'jotai'
import { useCallback, useRef } from 'react'
import { sidebarWidthAtom, SIDEBAR_WIDTH_BOUNDS } from '@/app/state'
import './SidebarResizer.css'

export function SidebarResizer() {
    const [width, setWidth] = useAtom(sidebarWidthAtom)
    const startRef = useRef<{ x: number; w: number } | null>(null)

    const onMove = useCallback(
        (e: PointerEvent) => {
            if (!startRef.current) return
            const dx = e.clientX - startRef.current.x
            setWidth(startRef.current.w + dx)
        },
        [setWidth]
    )

    const onUp = useCallback(() => {
        startRef.current = null
        document.body.style.cursor = ''
        document.documentElement.classList.remove('is-resizing-sidebar')
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
    }, [onMove])

    const onDown = (e: React.PointerEvent) => {
        if (e.button !== 0) return
        e.preventDefault()
        startRef.current = { x: e.clientX, w: width }
        document.body.style.cursor = 'col-resize'
        document.documentElement.classList.add('is-resizing-sidebar')
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
    }

    const onDoubleClick = () => {
        const reset = SIDEBAR_WIDTH_BOUNDS.min < 319 ? 319 : SIDEBAR_WIDTH_BOUNDS.min
        setWidth(reset)
    }

    return (
        <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            onPointerDown={onDown}
            onDoubleClick={onDoubleClick}
        >
            <div className="sidebar-resizer__line" />
        </div>
    )
}
