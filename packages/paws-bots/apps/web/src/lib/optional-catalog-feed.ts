/** Soft-fail the optional integrations catalog probe so core catalog load stays available. */
export function optionalCatalogFeedProbe<T extends { enabled: boolean; results: unknown[] }>(
  probe: Promise<T>,
): Promise<T | { enabled: false; results: [] }> {
  return probe.catch(() => ({ enabled: false, results: [] }));
}
