import { quotePlacement } from "../../paws/quote-placement";
import { listenWindow } from "../../paws/runtime";
import { hostRoot, embedded } from "../../paws/runtime";
import { useLingui } from "@lingui/react/macro";
import { Button, cn } from "@rakazo/ui-web";
import { TextQuote } from "lucide-react";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isDetachedRange } from "../../lib/quote-selection";

export const QuoteSelectionButton = memo(function QuoteSelectionButton({
  range,
  onQuote,
}: {
  range: Range;
  onQuote: () => void;
}) {
  const { t } = useLingui();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = useState<{
    top: number;
    left: number;
    above: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    const update = () => {
      if (isDetachedRange(range)) {
        setPlacement(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const width = buttonRef.current?.offsetWidth ?? 0;
      const height = buttonRef.current?.offsetHeight ?? 0;
      const host = embedded ? hostRoot().getBoundingClientRect() : { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
      setPlacement(quotePlacement(rect, host, { width, height }));
    };
    update();
    listenWindow("resize", update);
    // Scroll doesn't bubble — listen on the capture phase to catch any scroller.
    listenWindow("scroll", update, { capture: true, passive: true });
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [range]);

  return createPortal(
    // The wrapper owns the offset so the button's pressed nudge cannot move it.
    <div
      data-quote-selection
      style={placement ? { top: placement.top, left: placement.left } : { visibility: "hidden" }}
      className={cn(
        "fixed z-50 -translate-x-1/2",
        placement?.above === false ? "translate-y-0" : "-translate-y-full",
      )}
    >
      <Button
        ref={buttonRef}
        variant="floating"
        size="sm"
        data-testid="quote-selection"
        onMouseDown={(event) => {
          // Keep the highlight alive until the click commits the quote.
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={onQuote}
        className="px-3 shadow-md"
      >
        <TextQuote strokeWidth={2} />
        {t`Reply`}
      </Button>
    </div>,
    embedded ? hostRoot() : document.body,
  );
});
