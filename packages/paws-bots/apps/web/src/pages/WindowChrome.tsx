import { useLingui } from "@lingui/react/macro";
import { DARWIN_WINDOW_CONTROLS_WIDTH_PX, desktopBridge, windowChromeKind } from "../lib/desktop";

function chromeClass(base: string, className?: string) {
  return className ? `${base} ${className}` : base;
}

export function WindowChrome({ className }: { className?: string }) {
  const { t } = useLingui();
  const desktop = desktopBridge();
  const kind = windowChromeKind(desktop);
  if (kind === "spacer" || kind === "darwin") {
    return (
      <div
        className={chromeClass(
          kind === "darwin" ? "app-drag h-3 shrink-0" : "h-3 shrink-0",
          className,
        )}
        style={{ width: DARWIN_WINDOW_CONTROLS_WIDTH_PX }}
        aria-hidden="true"
      />
    );
  }
  return (
    <div className={chromeClass("app-drag flex shrink-0 gap-[7px]", className)}>
      <button
        type="button"
        className="app-no-drag h-3 w-3 rounded-full bg-[#FF5F57]"
        aria-label={t`Close`}
        onClick={() => void desktop?.window.close()}
      />
      <button
        type="button"
        className="app-no-drag h-3 w-3 rounded-full bg-[#FEBC2E]"
        aria-label={t`Minimize`}
        onClick={() => void desktop?.window.minimize()}
      />
      <button
        type="button"
        className="app-no-drag h-3 w-3 rounded-full bg-[#28C840]"
        aria-label={t`Fullscreen`}
        onClick={() => void desktop?.window.toggleMaximize()}
      />
    </div>
  );
}
