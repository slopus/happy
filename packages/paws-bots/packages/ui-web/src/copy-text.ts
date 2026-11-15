import type { RakazoDesktop } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";

/**
 * Copies by selecting the text in a hidden field, which works in the click that asked for it
 * where the Clipboard API does not exist: a self-hosted server on plain http, for one.
 */
function copyBySelection(text: string): boolean {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.setAttribute("aria-hidden", "true");
  field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
  // Next to the focused control, so a dialog's focus trap lets the selection happen.
  (active?.parentElement ?? document.body).append(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  field.remove();
  active?.focus({ preventScroll: true });
  return copied;
}

/** Keep browser copying first; only the desktop app can recover through its native bridge. */
export async function writeClipboard(text: string, isCurrent = () => true): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // A desktop document can lose focus even during a Copy click.
  }
  if (!isCurrent()) return false;
  const desktop = (globalThis as { rakazoDesktop?: RakazoDesktop }).rakazoDesktop;
  if (desktop?.clipboard) {
    try {
      if (await desktop.clipboard.writeText(text)) return true;
    } catch {
      // Older or disconnected bridges can still use the selection fallback.
    }
  }
  return isCurrent() && copyBySelection(text);
}

/**
 * Copy text and report a short-lived "copied" flag for button feedback, and whether the last
 * copy failed so the caller can offer the text to select by hand. Only the newest attempt's
 * outcome counts, and its exact text travels with the failure, so a result that arrives out of
 * order or a content change after the click cannot put different text in the fallback dialog.
 * `copy` resolves true only when its own attempt succeeded and still counts.
 */
export function useCopyText(): [
  copied: boolean,
  copy: (text: string) => Promise<boolean>,
  failed: boolean,
  reset: () => void,
  failedText: string,
] {
  const [state, setState] = useState<{ status: "idle" | "copied" | "failed"; text: string }>({
    status: "idle",
    text: "",
  });
  const attemptRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      // A copy that settles after unmount must not start a new feedback timer.
      attemptRef.current++;
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = (text: string) => {
    const attempt = ++attemptRef.current;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    // The earlier confirmation ends here; a write that never settles must not keep it on.
    setState((current) => (current.status === "copied" ? { status: "idle", text: "" } : current));
    return writeClipboard(text, () => attempt === attemptRef.current).then((ok) => {
      // A newer attempt superseded this one; its outcome decides.
      if (attempt !== attemptRef.current) return false;
      setState({ status: ok ? "copied" : "failed", text: ok ? "" : text });
      if (ok) {
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          if (attempt !== attemptRef.current) return;
          setState({ status: "idle", text: "" });
        }, 2000);
      }
      return ok;
    });
  };

  const reset = () => {
    // A copy still in flight must not reopen the dialog with its late failure.
    attemptRef.current++;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setState({ status: "idle", text: "" });
  };

  return [state.status === "copied", copy, state.status === "failed", reset, state.text];
}
