import { useRef } from "react";
import { Dialog, DialogContent, DialogTitle } from "./components/ui/dialog";
import { Textarea } from "./components/ui/textarea";

/** Offers selected text only after the browser refuses to copy it. */
export function CopyTextFallback({
  open,
  onOpenChange,
  text,
  label,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  text: string;
  label: string;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent initialFocus={field}>
        <DialogTitle>{label}</DialogTitle>
        <Textarea
          ref={field}
          aria-label={label}
          readOnly
          value={text}
          rows={8}
          onFocus={(event) => event.currentTarget.select()}
        />
      </DialogContent>
    </Dialog>
  );
}
