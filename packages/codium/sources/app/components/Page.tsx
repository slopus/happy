import { ReactNode } from 'react'

interface PageProps {
    title?: ReactNode
    actions?: ReactNode
    children?: ReactNode
    variant?: 'default' | 'chat'
}

export function Page({ title, actions, children, variant = 'default' }: PageProps) {
    const contentClass =
        variant === 'chat' ? 'page__content page__content--chat' : 'page__content'
    return (
        <>
            <header className="page__header">
                {title != null && <div className="page__header-title">{title}</div>}
                {actions != null && <div className="page__header-actions">{actions}</div>}
            </header>
            <div className={contentClass}>{children}</div>
        </>
    )
}
