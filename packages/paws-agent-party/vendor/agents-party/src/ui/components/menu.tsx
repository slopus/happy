import { Check } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { cn } from '../utils.js'
import { Button, type IconType } from './button.js'

export interface MenuOption<T extends string> {
  value: T
  label: string
  /** One line under the label saying what picking this does. */
  hint?: string
}

/**
 * A small single-select dropdown: a trigger button and a panel of options with a check beside the current one. It picks
 * on click, closes on Escape and on a click outside, and the arrows walk the panel. Hand-rolled on purpose — the
 * package ships no headless-menu dependency, and one radio menu is all it needs.
 */
export const Menu = <T extends string>({
  options,
  value,
  onSelect,
  label,
  icon,
  ariaLabel,
  triggerClassName,
  panelClassName,
}: {
  options: MenuOption<T>[]
  value: T
  onSelect: (value: T) => void
  /** Trigger content beside the icon; omit for an icon-only trigger. */
  label?: ReactNode
  icon?: IconType
  ariaLabel: string
  triggerClassName?: string
  /**
   * Where the panel hangs. It defaults to `right-0` — correct for a trigger sitting at the right edge — and the caller
   * overrides it when its own layout puts the trigger elsewhere, which only the caller knows.
   */
  panelClassName?: string
}) => {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const items = (): HTMLButtonElement[] => [
    ...(panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []),
  ]

  useEffect(() => {
    if (!open) {
      return
    }
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Open on the current option, so the arrows have somewhere to start and a keyboard user lands where they are.
  useEffect(() => {
    if (!open) {
      return
    }
    const index = options.findIndex((option) => option.value === value)
    items()[index === -1 ? 0 : index]?.focus()
  }, [open, options, value])

  const close = (): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div ref={rootRef} className="relative">
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        {...(icon === undefined ? {} : { icon })}
        {...(triggerClassName === undefined ? {} : { className: triggerClassName })}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        {label}
      </Button>
      {open && (
        <div
          ref={panelRef}
          role="menu"
          aria-label={ariaLabel}
          className={cn(
            'absolute top-full z-40 mt-1 w-64 rounded-md border border-border bg-card p-1 shadow-lg',
            panelClassName ?? 'right-0',
          )}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              close()
              return
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
              return
            }
            event.preventDefault()
            const all = items()
            const from = all.indexOf(document.activeElement as HTMLButtonElement)
            const next = (from + (event.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length
            all[next]?.focus()
          }}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              onClick={() => {
                onSelect(option.value)
                close()
              }}
              className="flex w-full cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:bg-muted"
            >
              <Check className={cn('mt-0.5 size-3.5 shrink-0', option.value === value ? 'opacity-100' : 'opacity-0')} />
              <span className="min-w-0">
                <span className="block font-accent text-xs font-semibold text-foreground">{option.label}</span>
                {option.hint !== undefined && (
                  <span className="block font-accent text-xs text-muted-foreground">{option.hint}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
