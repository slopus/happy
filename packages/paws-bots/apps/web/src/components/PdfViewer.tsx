import { useObjectUrl } from "../lib/use-object-url";

export function PdfViewer({ bytes, title }: { bytes: Uint8Array; title: string }) {
  const url = useObjectUrl(bytes, "application/pdf");
  if (!url) return null;
  return <iframe title={title} src={url} className="h-full w-full border-0" />;
}
