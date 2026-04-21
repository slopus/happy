import { ReactNode } from 'react'

interface PageProps {
    title?: ReactNode
    actions?: ReactNode
    children?: ReactNode
}

export function Page({ title, actions, children }: PageProps) {
    return (
        <>
            <header className="page__header">
                {title != null && <div className="page__header-title">{title}</div>}
                {actions != null && <div className="page__header-actions">{actions}</div>}
            </header>
            <div className="page__content">{children}</div>
        </>
    )
}
