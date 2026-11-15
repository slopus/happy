import { useEffect, useState } from "react";

export function useObjectUrl(bytes: Uint8Array, mimeType: string): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeType }));
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [bytes, mimeType]);

  return url;
}
