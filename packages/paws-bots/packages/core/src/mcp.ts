export function deriveMcpSlug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[_-]+|-+$/g, "")
      .slice(0, 64) || `mcp-${Date.now()}`
  );
}
