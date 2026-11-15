import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { Dialog, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const rowCount = Number(params.get("rows") ?? "12");
const rich = params.has("rich");
const richMany = params.has("rich-many");
const long = params.has("long");
const nested = params.has("nested");
const streaming = params.has("stream");
const tall = params.has("tall");
const rtl = params.has("rtl");
const wide = params.has("wide");
const dupCols = params.has("dup-cols");

const rows = Array.from(
  { length: rowCount },
  (_, i) => `| item-${String(i + 1).padStart(2, "0")} | ${(i * 7) % 13} |`,
);
const longValue =
  "This deliberately long table value contains enough words to wrap completely inside the expanded dialog without clipping or ellipsis.";
const initialMarkdown = rich
  ? "| [Reference](https://example.test/ref) | **Note** |\n| --- | --- |\n| [Docs](https://example.test/docs) | **important** and `code` |"
  : richMany
    ? [
        "| Reference | Qty |",
        "| --- | --- |",
        ...Array.from(
          { length: 12 },
          (_, i) =>
            `| [Docs ${String(i + 1).padStart(2, "0")}](https://example.test/docs/${i + 1}) | ${(i * 7) % 13} |`,
        ),
      ].join("\n")
    : long
      ? `| Item | Description |\n| --- | --- |\n| Alpha | ${longValue} |`
      : rtl
        ? ["| שם | כמות |", "| --- | ---: |", "| תפוח | 5 |", "| בננה | 3 |"].join("\n")
        : wide
          ? [
              `| ${Array.from({ length: 12 }, (_, i) => `Column ${i + 1}`).join(" | ")} |`,
              `| ${"--- | ".repeat(12)}`,
              `| ${Array.from({ length: 12 }, (_, i) => `value-${i + 1} padded to force overflow`).join(" | ")} |`,
            ].join("\n")
          : dupCols
            ? "|  | Qty | Qty |\n| --- | --- | --- |\n| a | 1 | 2 |"
            : ["| Item | Qty |", "| --- | --- |", ...rows].join("\n");

function Fixture() {
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [outerOpen, setOuterOpen] = useState(nested);

  useEffect(() => {
    if (!streaming) return;
    const update = (event: Event) => {
      setMarkdown((event as CustomEvent<{ markdown: string }>).detail.markdown);
    };
    window.addEventListener("rk-table-stream-update", update);
    return () => window.removeEventListener("rk-table-stream-update", update);
  }, []);

  const content = (
    <main
      className="min-h-screen bg-background p-8 text-foreground"
      style={nested ? { minHeight: "auto", padding: 0 } : undefined}
    >
      {tall ? <div aria-hidden="true" style={{ height: "900px" }} /> : null}
      <div data-testid="table-fixture" dir={rtl ? "auto" : undefined} style={{ maxWidth: "40rem" }}>
        <ChatMarkdown streaming={streaming}>{markdown}</ChatMarkdown>
      </div>
      {tall ? <div aria-hidden="true" style={{ height: "900px" }} /> : null}
    </main>
  );

  if (!nested) return content;
  return (
    <Dialog open={outerOpen} onOpenChange={setOuterOpen}>
      <DialogContent style={{ width: "min(48rem, 94vw)", maxWidth: "none" }}>
        <DialogTitle>Outer preview</DialogTitle>
        {content}
      </DialogContent>
    </Dialog>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
