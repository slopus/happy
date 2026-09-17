import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'
import { cn } from '../utils.js'

type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>['size']>

/** Lucide-style icon component: takes a `className` and renders an SVG. */
export type IconType = React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>

const buttonVariants = cva(
  "group/button relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md border border-transparent bg-clip-padding font-accent text-sm font-semibold whitespace-nowrap outline-none select-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        outline:
          'border-primary bg-background text-primary hover:border-primary-hover hover:bg-link-hover/7 hover:text-primary-hover aria-expanded:bg-link-hover/7 aria-expanded:text-primary-hover dark:border-link dark:text-link dark:hover:bg-link-hover/30',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary-hover aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
        // Bordered, input-looking sibling of `secondary`: rests as an outline on the page background, fills on hover.
        'outline-secondary':
          'border-input bg-background text-secondary-foreground shadow-xs hover:bg-secondary hover:text-secondary-foreground aria-expanded:bg-secondary dark:bg-input/30 dark:hover:bg-input/50',
        ghost:
          'hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50',
        destructive:
          'bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40',
        success:
          'bg-success/10 text-success hover:bg-success/20 focus-visible:border-success/40 focus-visible:ring-success/20 dark:bg-success/20 dark:hover:bg-success/30 dark:focus-visible:ring-success/40',
        warning:
          'bg-warning/10 text-warning hover:bg-warning/20 focus-visible:border-warning/40 focus-visible:ring-warning/20 dark:bg-warning/20 dark:hover:bg-warning/30 dark:focus-visible:ring-warning/40',
        info: 'bg-info/10 text-info hover:bg-info/20 focus-visible:border-info/40 focus-visible:ring-info/20 dark:bg-info/20 dark:hover:bg-info/30 dark:focus-visible:ring-info/40',
        link: 'link',
      },
      size: {
        default: 'h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),8px)] px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 gap-1 rounded-[min(var(--radius-md),10px)] px-2.5 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5',
        lg: 'h-10 gap-1.5 px-2.5 text-base has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3',
        xl: 'h-11 gap-2 px-3 text-base has-data-[icon=inline-end]:pr-3.5 has-data-[icon=inline-start]:pl-3.5',
        '2xl': 'h-12 gap-2.5 px-3.5 text-base has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4',
        icon: 'size-9',
        'icon-default': 'size-9',
        'icon-xs': "size-6 rounded-[min(var(--radius-md),8px)] [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8 rounded-[min(var(--radius-md),10px)]',
        'icon-lg': 'size-10',
        'icon-xl': 'size-11',
        'icon-2xl': 'size-12',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

type ButtonProps = React.ComponentPropsWithoutRef<'button'> &
  VariantProps<typeof buttonVariants> & {
    icon?: IconType
    iconPosition?: 'start' | 'end'
  }

/**
 * The shared button: same variants and sizes as the site, minus its router/Slot/tooltip machinery. An icon-only button
 * (no children) collapses to the matching square `icon-*` size automatically.
 */
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'default', size, icon: Icon, iconPosition = 'start', children, ...props },
  ref,
) {
  const hasContent = children !== undefined && children !== null && children !== false
  // An icon-only button (no children) collapses to the matching square icon size.
  const iconSizeBySize: Partial<Record<ButtonSize, ButtonSize>> = {
    xs: 'icon-xs',
    sm: 'icon-sm',
    lg: 'icon-lg',
    xl: 'icon-xl',
    '2xl': 'icon-2xl',
    icon: 'icon',
    'icon-default': 'icon-default',
    'icon-xs': 'icon-xs',
    'icon-sm': 'icon-sm',
    'icon-lg': 'icon-lg',
    'icon-xl': 'icon-xl',
    'icon-2xl': 'icon-2xl',
  }
  const buttonSize: ButtonSize = hasContent ? (size ?? 'default') : size ? (iconSizeBySize[size] ?? 'icon') : 'icon'

  return (
    <button
      ref={ref}
      data-slot="button"
      data-variant={variant}
      data-size={buttonSize}
      data-icon={Icon ? (iconPosition === 'start' ? 'inline-start' : 'inline-end') : undefined}
      className={cn(buttonVariants({ variant, size: buttonSize, className }))}
      {...props}
    >
      {Icon && iconPosition === 'start' ? <Icon aria-hidden /> : null}
      {hasContent ? <span>{children}</span> : null}
      {Icon && iconPosition === 'end' ? <Icon aria-hidden /> : null}
    </button>
  )
})

export { Button, buttonVariants, type ButtonProps, type ButtonSize }
