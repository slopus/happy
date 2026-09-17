import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'
import { cn } from '../utils.js'

const inputVariants = cva(
  'w-full min-w-0 font-accent text-accent-foreground transition-colors transition-opacity outline-none file:inline-flex file:border-0 file:bg-transparent file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50',
  {
    variants: {
      variant: {
        default: 'border border-input bg-transparent dark:bg-input/30',
        ghost: 'border border-transparent bg-transparent dark:bg-transparent',
      },
      inputSize: {
        default: 'h-9 rounded-md px-2.5 py-1 text-base file:h-7 file:text-sm md:text-sm',
        xs: 'h-6 rounded-[min(var(--radius-md),8px)] px-2 text-xs file:h-5 file:text-xs',
        sm: 'h-8 rounded-[min(var(--radius-md),10px)] px-2.5 text-sm file:h-6 file:text-sm',
        lg: 'h-10 rounded-md px-2.5 text-base file:h-8 file:text-sm md:text-sm',
        xl: 'h-11 rounded-md px-3 text-base file:h-9 file:text-sm md:text-sm',
        '2xl': 'h-12 rounded-md px-3.5 text-base file:h-10 file:text-base',
      },
    },
    defaultVariants: {
      variant: 'default',
      inputSize: 'default',
    },
  },
)

type InputProps = React.ComponentPropsWithoutRef<'input'> & VariantProps<typeof inputVariants>

const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type, variant = 'default', inputSize = 'default', disabled, ...props },
  ref,
) {
  return (
    <input
      type={type}
      ref={ref}
      data-slot="input"
      data-variant={variant}
      data-size={inputSize}
      data-disabled={disabled}
      disabled={disabled}
      className={cn(inputVariants({ variant, inputSize, className }))}
      {...props}
    />
  )
})

export { Input, inputVariants }
