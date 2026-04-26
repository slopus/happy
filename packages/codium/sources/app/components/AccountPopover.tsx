import { MenuSeparator } from './MenuSeparator'
import './AccountPopover.css'

interface AccountPopoverProps {
    name?: string
    email?: string
}

function CheckIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
        </svg>
    )
}

export function AccountPopover({
    name = 'Steve',
    email = 'steve@example.com',
}: AccountPopoverProps) {
    return (
        <div className="account-popover" role="menu" aria-label="Account">
            <div className="account-popover__identity">
                <div className="account-popover__avatar" aria-hidden="true">
                    {name.slice(0, 1).toUpperCase()}
                </div>
                <div className="account-popover__copy">
                    <div className="account-popover__name">{name}</div>
                    <div className="account-popover__email">{email}</div>
                </div>
            </div>
            <MenuSeparator />
            <button type="button" className="account-popover__item" role="menuitem">
                <span>Pro plan</span>
                <CheckIcon />
            </button>
            <button type="button" className="account-popover__item" role="menuitem">
                <span>Manage subscription</span>
            </button>
            <button type="button" className="account-popover__item" role="menuitem">
                <span>Usage</span>
                <span className="account-popover__hint">72%</span>
            </button>
            <MenuSeparator />
            <button type="button" className="account-popover__item" role="menuitem">
                <span>Settings</span>
            </button>
            <button type="button" className="account-popover__item account-popover__item--danger" role="menuitem">
                <span>Sign out</span>
            </button>
        </div>
    )
}
