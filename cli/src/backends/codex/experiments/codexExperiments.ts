export function isExperimentalCodexVendorResumeEnabled(): boolean {
  const raw = process.env.HAPPY_EXPERIMENTAL_CODEX_RESUME;
  return typeof raw === 'string' && ['true', '1', 'yes'].includes(raw.trim().toLowerCase());
}

export function isExperimentalCodexAcpEnabled(): boolean {
  const raw = process.env.HAPPY_EXPERIMENTAL_CODEX_ACP;
  return typeof raw === 'string' && ['true', '1', 'yes'].includes(raw.trim().toLowerCase());
}

