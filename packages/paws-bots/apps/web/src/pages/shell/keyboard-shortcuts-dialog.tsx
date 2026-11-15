import { useLingui } from "@lingui/react/macro";
import { Dialog, DialogContent, DialogHeader, DialogTitle, Kbd, KbdGroup } from "@rakazo/ui-web";
import type { ShortcutHost } from "./shell-shortcuts";

type Row = { label: string; keys: string[][] };

export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
  host,
  dictation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  host: ShortcutHost;
  /** Whether the composer offers the microphone, which Cmd/Ctrl+D starts. */
  dictation: boolean;
}) {
  const { t } = useLingui();
  const mod = host.apple ? "⌘" : "Ctrl";
  const shift = host.apple ? "⇧" : "Shift";
  const ctrl = host.apple ? "⌃" : "Ctrl";
  // Browsers keep some chords for themselves, so those rows show only in the desktop app.
  const rows: (Row | false)[] = [
    { label: t`Command menu`, keys: [[mod, "K"]] },
    { label: t`New`, keys: [[mod, "N"]] },
    host.desktop && { label: t`New group chat`, keys: [[mod, shift, "N"]] },
    host.desktop && { label: t`Find in chat`, keys: [[mod, "F"]] },
    host.desktop && { label: t`Search bots`, keys: [[mod, shift, "F"]] },
    { label: t`Toggle sidebar`, keys: [[mod, "B"]] },
    { label: t`Focus message`, keys: [[mod, "I"]] },
    dictation && { label: t`Dictate`, keys: [[mod, "D"]] },
    { label: t`Chat details`, keys: [[mod, shift, ","]] },
    { label: t`Connect apps`, keys: [[mod, shift, "M"]] },
    host.desktop && { label: t`Go to bot`, keys: [[mod, "1–9"]] },
    {
      label: t`Next or previous bot`,
      keys: host.desktop
        ? [
            [ctrl, "Tab"],
            [ctrl, shift, "Tab"],
          ]
        : [
            [mod, shift, "↓"],
            [mod, shift, "↑"],
          ],
    },
    host.desktop && {
      label: t`Back or forward`,
      keys: host.apple
        ? [
            [mod, "["],
            [mod, "]"],
          ]
        : [
            ["Alt", "←"],
            ["Alt", "→"],
          ],
    },
    host.desktop && { label: t`Settings`, keys: [[mod, ","]] },
    { label: t`Keyboard shortcuts`, keys: [[mod, "/"]] },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
        data-testid="keyboard-shortcuts-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t`Keyboard shortcuts`}</DialogTitle>
        </DialogHeader>
        <dl className="divide-y divide-border">
          {rows
            .filter((row): row is Row => row !== false)
            .map((row) => (
              <div
                key={row.label}
                className="flex items-center justify-between gap-4 py-2 text-body"
              >
                <dt className="text-foreground">{row.label}</dt>
                <dd className="flex shrink-0 items-center gap-2">
                  {row.keys.map((chord) => (
                    <KbdGroup key={chord.join("+")}>
                      {chord.map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </KbdGroup>
                  ))}
                </dd>
              </div>
            ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
