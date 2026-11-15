export interface NumericSummary {
  count: number;
  min: number;
  median: number;
  p95: number;
  max: number;
}

export const PERFORMANCE_REPORT_SCHEMA_VERSION = 2 as const;

export interface PerformanceReport {
  schemaVersion: typeof PERFORMANCE_REPORT_SCHEMA_VERSION;
  label: string;
  createdAt: string;
  environment: {
    gitSha: string;
    gitDirty: boolean;
    platform: string;
    release: string;
    arch: string;
    cpuModel: string;
    cpuCount: number;
    totalMemoryBytes: number;
    node: string;
    electron?: string;
    chrome?: string;
    playwright: string;
    buildMode: string;
    rendererMode: string;
    warmWindow: string;
    assetDelayMs?: number;
  };
  fixture: {
    backend: string;
    messageCount: number;
    webOrigin: string;
    launchSamples: number;
    cacheColdDefinition: string;
    warmDefinition: string;
  };
  launches: { cacheCold: unknown[]; warm: unknown[] };
  interactions: unknown;
  bundles: {
    web: BundleSize;
    desktop: BundleSize | null;
  };
  summary: {
    cacheColdShellUsableMs: NumericSummary;
    warmShellUsableMs: NumericSummary;
    settingsPaintedMs: number;
    settingsSettledMs: number;
    typingKeyPaintMs: NumericSummary;
    idleCpuPercent: NumericSummary;
    idleSummedWorkingSetKiB: NumericSummary;
    streamingCpuPercent: NumericSummary;
    reopenMs: number | null;
    hiddenSummedWorkingSetKiB: number | null;
  };
}

export interface BundleSize {
  fileCount: number;
  rawBytes: number;
  gzipBytes: number;
  brotliBytes: number;
}

export function summarize(values: number[]): NumericSummary {
  if (values.length === 0) throw new Error("Cannot summarize an empty sample");
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0]!,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1)!,
  };
}

export function roundedSummary(values: number[]): NumericSummary {
  const summary = summarize(values);
  return {
    count: summary.count,
    min: roundMetric(summary.min),
    median: roundMetric(summary.median),
    p95: roundMetric(summary.p95),
    max: roundMetric(summary.max),
  };
}

export function percentageDelta(before: number, after: number) {
  if (before === 0) return after === 0 ? 0 : null;
  return ((after - before) / before) * 100;
}

export function roundMetric(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

export function parsePerformanceReport(value: unknown, source: string): PerformanceReport {
  if (!isRecord(value)) throw invalidReport(source, "expected a JSON object");
  if (value.schemaVersion !== 1 && value.schemaVersion !== PERFORMANCE_REPORT_SCHEMA_VERSION) {
    throw invalidReport(
      source,
      `unsupported schemaVersion ${JSON.stringify(value.schemaVersion)} (supported: 1, ${PERFORMANCE_REPORT_SCHEMA_VERSION})`,
    );
  }
  if (typeof value.label !== "string") throw invalidReport(source, "label must be a string");
  if (!isRecord(value.environment)) {
    throw invalidReport(source, "environment must be an object");
  }
  if (!isRecord(value.summary)) throw invalidReport(source, "summary must be an object");

  const normalized =
    value.schemaVersion === 1
      ? migrateSchemaOne(value, source)
      : ({ ...value, schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION } as Record<string, unknown>);
  assertSummary(normalized.summary, source);
  return normalized as unknown as PerformanceReport;
}

export function parseTcpPort(value: string, name: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(
      `${name} must be an integer between 1 and 65535; received ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

function migrateSchemaOne(value: Record<string, unknown>, source: string) {
  const summary = value.summary;
  if (!isRecord(summary)) throw invalidReport(source, "summary must be an object");
  if (!("idleSummedPrivateKiB" in summary)) {
    throw invalidReport(source, "summary.idleSummedPrivateKiB is missing from schema 1 report");
  }
  return {
    ...value,
    schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION,
    summary: {
      ...summary,
      idleSummedWorkingSetKiB: summary.idleSummedPrivateKiB,
      reopenMs: summary.reopenMs ?? null,
      hiddenSummedWorkingSetKiB: summary.hiddenSummedPrivateKiB ?? null,
    },
  };
}

function assertSummary(
  value: unknown,
  source: string,
): asserts value is PerformanceReport["summary"] {
  if (!isRecord(value)) throw invalidReport(source, "summary must be an object");
  for (const key of [
    "cacheColdShellUsableMs",
    "warmShellUsableMs",
    "typingKeyPaintMs",
    "idleCpuPercent",
    "idleSummedWorkingSetKiB",
    "streamingCpuPercent",
  ] as const) {
    if (!isNumericSummary(value[key])) {
      throw invalidReport(source, `summary.${key} must be a numeric summary`);
    }
  }
  for (const key of ["settingsPaintedMs", "settingsSettledMs"] as const) {
    if (!isFiniteNumber(value[key])) {
      throw invalidReport(source, `summary.${key} must be a finite number`);
    }
  }
  for (const key of ["reopenMs", "hiddenSummedWorkingSetKiB"] as const) {
    if (value[key] !== null && !isFiniteNumber(value[key])) {
      throw invalidReport(source, `summary.${key} must be a finite number or null`);
    }
  }
}

function isNumericSummary(value: unknown): value is NumericSummary {
  if (!isRecord(value)) return false;
  return (
    Number.isInteger(value.count) &&
    (value.count as number) > 0 &&
    isFiniteNumber(value.min) &&
    isFiniteNumber(value.median) &&
    isFiniteNumber(value.p95) &&
    isFiniteNumber(value.max)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidReport(source: string, detail: string) {
  return new Error(`Invalid performance report ${source}: ${detail}`);
}

function percentile(sorted: number[], quantile: number) {
  if (sorted.length === 1) return sorted[0]!;
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}
