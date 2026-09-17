import * as React from 'react'
import { cn } from '../utils.js'

type TextareaProps = React.ComponentPropsWithoutRef<'textarea'>

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      data-slot="textarea"
      ref={ref}
      className={cn(
        'focus-visible:border-ring aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 transition-colors border-input dark:bg-input/30 rounded-md border bg-transparent px-2.5 py-2 text-base shadow-xs md:text-sm placeholder:text-muted-foreground flex field-sizing-content min-h-16 w-full outline-none disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
})

export { Textarea }
